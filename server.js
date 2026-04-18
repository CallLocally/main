// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// CallLocally â server.js (FIXED)
// All audit fixes applied. See FIX comments throughout.
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const express = require('express');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1); // Railway runs behind a proxy

// ââ SECURITY MIDDLEWARE ââ
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: ['https://calllocally.com', 'https://main-production-147d.up.railway.app'] }));

// Stripe webhook needs raw body â must be before express.json()
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ââ RATE LIMITING ââ
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many signups from this IP, try again later' },
  standardHeaders: true, legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
});

// FIX [2f]: Separate rate limiter for Twilio webhooks â much higher ceiling
// so legitimate call bursts don't get blocked, but still prevents abuse
const twilioWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 1000,
  standardHeaders: true, legacyHeaders: false,
  message: '<?xml version="1.0"?><Response><Say>Service temporarily unavailable.</Say></Response>',
});

// Only apply apiLimiter to non-webhook API routes
// FIX [2f]: Don't apply the tight 100/15min limiter to Twilio webhook endpoints
app.use('/api/signup', signupLimiter);
app.use('/api/leads', apiLimiter);
app.use('/api/user', apiLimiter);
app.use('/api/admin', apiLimiter);
app.use('/api/create-checkout', apiLimiter);
app.use('/api/billing-portal', apiLimiter);

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://calllocally.com';
const ADMIN_TWILIO_NUMBER = process.env.ADMIN_TWILIO_NUMBER || '+19497968059';
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// FIX [A2P 10DLC]: smsCreate wraps twilioClient.messages.create so outbound SMS
// goes through the A2P-registered Messaging Service pool when one is configured.
// Without this wrapper, carriers reject all messages (error 30034).
// When TWILIO_MESSAGING_SERVICE_SID is set, the `from:` is stripped and Twilio
// picks a sender from the service pool (using sticky-sender rules).
function smsCreate(opts) {
  const ms = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (ms) {
    const { from, ...rest } = opts;
    return smsCreate({ ...rest, messagingServiceSid: ms });
  }
  return smsCreate(opts);
}
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  solo:   { name: 'Solo',   price: 4900,  priceId: process.env.STRIPE_PRICE_SOLO },
  growth: { name: 'Growth', price: 7900,  priceId: process.env.STRIPE_PRICE_GROWTH },
  team:   { name: 'Team',   price: 12900, priceId: process.env.STRIPE_PRICE_TEAM },
};

// ââ POSTGRES ââ
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// FIX [7d]: Global error handlers to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message, err.stack);
  // Don't exit â Railway will restart, but we lose in-flight requests
  // In production, you'd want to drain and restart gracefully
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      auth_token TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      business_name TEXT NOT NULL,
      business_phone TEXT NOT NULL,
      trade TEXT DEFAULT 'general',
      twilio_number TEXT,
      custom_message TEXT,
      after_hours_message TEXT,
      business_hours JSONB,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      team_phones JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      trial_ends_at TIMESTAMPTZ,
      plan TEXT,
      paid BOOLEAN DEFAULT FALSE,
      paid_through TIMESTAMPTZ,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      last_trial_notification INT,
      total_leads INT DEFAULT 0,
      total_urgent INT DEFAULT 0,
      carrier TEXT DEFAULT 'other',
      tfv_notified BOOLEAN DEFAULT FALSE,
      tfv_submission_failed BOOLEAN DEFAULT FALSE
    );
    -- Safe migrations for existing DBs
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_phones JSONB DEFAULT '[]';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS total_leads INT DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS total_urgent INT DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS carrier TEXT DEFAULT 'other';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tfv_notified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tfv_submission_failed BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      caller_phone TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      service TEXT,
      address TEXT,
      urgent BOOLEAN DEFAULT FALSE,
      after_hours BOOLEAN DEFAULT FALSE,
      conversation JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      captured_at TIMESTAMPTZ,
      sent_from TEXT
    );
    -- FIX [3/6a]: Add sent_from column to track which number the SMS was sent from
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS sent_from TEXT;

    CREATE TABLE IF NOT EXISTS processed_stripe_events (
      event_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS leads_user_id_idx ON leads(user_id);
    CREATE INDEX IF NOT EXISTS leads_caller_idx ON leads(caller_phone, status);
    CREATE INDEX IF NOT EXISTS users_twilio_idx ON users(twilio_number);
    CREATE INDEX IF NOT EXISTS users_stripe_customer_idx ON users(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS users_stripe_sub_idx ON users(stripe_subscription_id);

    -- FIX [6a]: Partial unique index to prevent duplicate pending leads per caller per contractor
    CREATE UNIQUE INDEX IF NOT EXISTS leads_pending_dedup_idx
      ON leads(user_id, caller_phone) WHERE status = 'pending';

    -- FIX [6c]: Better composite index for the SMS reply lookup
    CREATE INDEX IF NOT EXISTS leads_caller_status_created_idx
      ON leads(caller_phone, status, created_at DESC);

    -- FIX [6e]: Clean up old processed Stripe events (older than 90 days)
    DELETE FROM processed_stripe_events WHERE processed_at < NOW() - INTERVAL '90 days';
  `);
  console.log('DB initialized');
}

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// HELPER FUNCTIONS
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function getSenderNumber(user) {
  // FIX [1f]: Removed dead reference to user.tfv_status (column doesn't exist)
  if (user.tfv_notified === true) return user.twilio_number;
  return ADMIN_TWILIO_NUMBER;
}

function formatPhone(raw) {
  const d = raw.replace(/\D/g, '');
  return d.startsWith('1') ? `+${d}` : `+1${d}`;
}

// ââ CARRIER FORWARDING CODES ââ
// FIX [1g]: Single source of truth for carrier forwarding codes
function getCarrierInstructions(carrier, twilioNumber) {
  const digits = twilioNumber.replace('+', '').replace(/\D/g, '');
  const num = twilioNumber;

  const instructions = {
    tmobile: {
      name: 'T-Mobile',
      dialCode: `**61*1${digits}#`,
      extra: `<p style="font-size:13px;color:#888;margin-top:8px">T-Mobile tip: If this doesn't work, call <b>611</b> from your phone and say "Set up call forwarding when unanswered to ${num}". Takes 2 minutes.</p>`
    },
    att: {
      name: 'AT&T',
      dialCode: `*61*${digits}**18#`,
      extra: ''
    },
    verizon: {
      name: 'Verizon',
      dialCode: `*71${digits}`,
      extra: ''
    },
    other: {
      name: 'your carrier',
      dialCode: `*61*${digits}**18#`,
      extra: `<p style="font-size:13px;color:#888;margin-top:8px">If this code doesn't work for your carrier, text us at hello@calllocally.com and we'll send you the right one.</p>`
    }
  };

  return instructions[carrier] || instructions.other;
}

// ââ TRADE-SPECIFIC MESSAGES ââ
function getTradeMessage(businessName, trade, afterHours = false) {
  const biz = businessName;
  const ah = afterHours;
  const base = {
    plumbing:    ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what's the plumbing issue and your address? (leak, clog, no hot water) I'll text back first thing in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. What's the plumbing issue and your address? (leak, clog, no hot water) I'll text back ASAP with timing & pricing.`,
    hvac:        ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what's going on with your heating or AC, and what's your address? I'll text back in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. What's the HVAC issue and address? (no heat, no AC, strange noise) I'll text back ASAP with timing & pricing.`,
    electrical:  ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what's the electrical issue and your address? Reply URGENT if it's an emergency.`
                    : `Hi! This is ${biz} — sorry I missed your call. What's the electrical issue and address? (outage, breaker, new install) I'll text back ASAP with timing & pricing.`,
    roofing:     ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but is this a repair, inspection, or replacement? And what's the address? I'll text back in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. Is this a repair, inspection, or replacement? And what's the property address? I'll text back ASAP with timing & pricing.`,
    landscaping: ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what service do you need and what's your address? (lawn, trees, sprinklers) I'll text back in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. What landscaping service and the address? (lawn, trees, sprinklers, cleanup) I'll text back ASAP with timing & pricing.`,
    pest:        ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what pest issue and your address? I'll text back in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. What pest issue and the address? (ants, rodents, termites) I'll text back ASAP with timing & pricing.`,
    handyman:    ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what do you need done and what's the address? I'll text back in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. What do you need fixed or built, and what's the address? I'll text back ASAP with timing & pricing.`,
    painting:    ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but interior or exterior painting? And what's the address? I'll text back in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. Interior or exterior painting? And what's the address? I'll text back ASAP with timing & pricing.`,
    pool:        ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what's the pool issue and your address? I'll text back in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. What's the pool issue and the address? (repair, cleaning, equipment, green water) I'll text back ASAP with timing & pricing.`,
    general:     ah ? `Hi! This is ${biz} — sorry I missed you. We're closed, but what service do you need and what's your address? I'll text back first thing in the morning.`
                    : `Hi! This is ${biz} — sorry I missed your call. What's going on and what's your address? I'll text back with timing & pricing ASAP.`,
    };
  return base[trade] || base.general;
}

function isActive(user) {
  if (user.paid) return true;
  if (user.paid_through && new Date(user.paid_through) > new Date()) return true;
  if (user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  // FIX [1e]: Also check for tfv_submission_failed â don't keep broken users active forever
  if (!user.trial_ends_at && !user.paid && user.tfv_notified !== true && user.tfv_submission_failed !== true) return true;
  return false;
}

function isBusinessHours(user) {
  if (!user.business_hours) return true;
  const now = new Date();
  const tz = user.timezone || 'America/Los_Angeles';
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const hour = local.getHours();
  const day = local.getDay();
  const { startHour = 7, endHour = 20, weekendOn = false } = user.business_hours;
  if (!weekendOn && (day === 0 || day === 6)) return false;
  return hour >= startHour && hour < endHour;
}

// ââ TWILIO SIGNATURE VALIDATION ââ
function validateTwilio(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = `${RAILWAY_URL}${req.originalUrl}`;
  const isValid = twilio.validateRequest(authToken, signature, url, req.body || {});
  if (!isValid) {
    console.warn('Invalid Twilio signature from', req.ip);
    return res.status(403).send('Forbidden');
  }
  next();
}

// FIX [7b]: Helper to return safe TwiML error response
function twimlError(res, message = 'Sorry, a system error occurred. Please try again.') {
  res.set('Content-Type', 'text/xml');
  return res.send(`<?xml version="1.0"?><Response><Say voice="Polly.Joanna">${message}</Say></Response>`);
}

// ââ DASHBOARD AUTH ââ
// FIX [7a]: Wrap in try/catch so DB errors don't crash the server
async function requireAuth(req, res, next) {
  try {
    const token = req.headers['x-auth-token'] || req.query.token;
    const userId = req.params.userId || req.query.userId;
    if (!token || !userId) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await pool.query('SELECT id FROM users WHERE id=$1 AND auth_token=$2', [userId, token]);
    if (!rows.length) return res.status(401).json({ error: 'Unauthorized' });
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// TOLL-FREE VERIFICATION
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// FIX [1a]: Single definition â removed duplicate
async function submitTollFreeVerification(user) {
  const TSID = process.env.TWILIO_ACCOUNT_SID;
  const TTOKEN = process.env.TWILIO_AUTH_TOKEN;
  const nameParts = (user.name || 'Owner').trim().split(' ');
  const firstName = nameParts[0] || 'Owner';
  const lastName = nameParts.slice(1).join(' ') || firstName;
  const biz = user.businessName || user.business_name || user.name;
  const body = new URLSearchParams({
    TollfreePhoneNumberSid: user.phoneSid,
    NotificationEmail: user.email,
    BusinessName: biz,
    BusinessWebsite: 'https://calllocally.com',
    BusinessStreetAddress: '505 35th St Apt A',
    BusinessCity: 'Newport Beach',
    BusinessStateProvinceRegion: 'CA',
    BusinessPostalCode: '92663',
    BusinessCountry: 'US',
    BusinessType: 'SOLE_PROPRIETOR',
    BusinessContactFirstName: firstName,
    BusinessContactLastName: lastName,
    BusinessContactEmail: user.email,
    BusinessContactPhone: user.businessPhone || user.business_phone || user.twilioNumber,
    UseCaseCategories: 'ACCOUNT_NOTIFICATIONS',
    UseCaseSummary: `CallLocally sends automated SMS to missed callers on behalf of ${biz}, a home service contractor. When a customer calls and gets no answer, CallLocally texts the caller to capture their service need and address, sends an acknowledgment when the caller replies, and relays the contractor's replies back through the same number so the entire conversation stays in one thread. Transactional lead-capture messages only. No marketing.`,
    ProductionMessageSample: `Hi! This is ${biz} — sorry I missed your call. What's going on and what's your address? I'll text back with timing & pricing ASAP.`,
    OptInType: 'VERBAL',
    OptInImageUrls: 'https://calllocally.com',
    MessageVolume: '10',
    AdditionalInformation: 'Automated lead capture for home service contractors. Callers opt in by calling the business number.',
  });
  try {
    const r = await fetch('https://messaging.twilio.com/v1/Tollfree/Verifications', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TSID}:${TTOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const d = await r.json();
    if (d.sid) {
      console.log(`TFV submitted for ${user.twilioNumber}: ${d.sid} status=${d.status}`);
      return true;
    } else {
      console.error(`TFV failed for ${user.twilioNumber}:`, JSON.stringify(d));
      return false;
    }
  } catch (e) {
    console.error('TFV submission error:', e.message);
    return false;
  }
}


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// SIGNUP
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.post('/api/signup', signupLimiter, async (req, res) => {
  const { name, email, businessName, businessPhone, trade, carrier, smsConsent } = req.body;
  if (!name || !email || !businessName || !businessPhone)
    return res.status(400).json({ error: 'All fields required' });
  if (!smsConsent) return res.status(400).json({ error: 'SMS consent is required' });

  const cleanEmail = email.toLowerCase().trim().slice(0, 255);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail))
    return res.status(400).json({ error: 'Invalid email' });

  // FIX [rollback]: Track purchased number at outer scope so we can release it on failure
  let purchased = null;
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [cleanEmail]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered' });

    const formattedPhone = formatPhone(businessPhone);

    // Provision toll-free number
    const tfAvail = await twilioClient.availablePhoneNumbers('US').tollFree.list({ limit: 1 });
    if (!tfAvail.length) throw new Error('No toll-free numbers available');
    purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: tfAvail[0].phoneNumber,
      voiceUrl: `${RAILWAY_URL}/api/forward`, voiceMethod: 'POST',
      statusCallback: `${RAILWAY_URL}/api/call-status`, statusCallbackMethod: 'POST',
      smsUrl: `${RAILWAY_URL}/api/twilio/sms`, smsMethod: 'POST',
    });

    const userId = uuidv4();
    const authToken = uuidv4();

    await pool.query(`
      INSERT INTO users (id, auth_token, name, email, business_name, business_phone, trade, twilio_number, custom_message, after_hours_message, trial_ends_at, carrier, sms_consent_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      userId, authToken, name.slice(0, 100), cleanEmail, businessName.slice(0, 200),
      formattedPhone, trade || 'general', purchased.phoneNumber,
      null, null, null, carrier || 'other', new Date().toISOString(),
    ]);

    await sendWelcomeEmail({ name, email: cleanEmail, businessName, twilioNumber: purchased.phoneNumber, id: userId, authToken, carrier: carrier || 'other' });

    // FIX [5c]: Track TFV submission failure so user doesn't get stuck
    const tfvSuccess = await submitTollFreeVerification({
      name, email: cleanEmail, businessName, business_name: businessName,
      twilioNumber: purchased.phoneNumber, phoneSid: purchased.sid,
      businessPhone: formattedPhone,
    });
    if (!tfvSuccess) {
      await pool.query('UPDATE users SET tfv_submission_failed=TRUE WHERE id=$1', [userId]);
      console.error(`TFV submission failed for ${cleanEmail} â flagged for manual review`);
    }

    console.log(`Signup: ${businessName} â ${purchased.phoneNumber}`);
    res.json({ success: true, userId, authToken, twilioNumber: purchased.phoneNumber });
  } catch (err) {
    console.error('Signup error:', err.message);
    // FIX [rollback]: Release orphaned toll-free number so we don't get billed for it
    if (purchased && purchased.sid) {
      try {
        await twilioClient.incomingPhoneNumbers(purchased.sid).remove();
        console.log(`Released orphaned number ${purchased.phoneNumber} after signup failure`);
      } catch (releaseErr) {
        console.error(`Failed to release ${purchased.phoneNumber}:`, releaseErr.message);
      }
    }
    // FIX [2e]: Don't leak internal error details
    res.status(500).json({ error: 'Signup failed. Please try again or contact support.' });
  }
});


// ── HEALTH CHECK (Railway liveness) ──
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
});


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// STRIPE
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { userId, plan, authToken } = req.body;
  if (!userId || !PLANS[plan]) return res.status(400).json({ error: 'userId and plan required' });

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1 AND auth_token=$2', [userId, authToken]);
    if (!rows.length) return res.status(401).json({ error: 'Unauthorized' });
    const user = rows[0];

    const planCfg = PLANS[plan];
    if (!planCfg.priceId) return res.status(500).json({ error: `Price ID for ${plan} not set` });

    let cid = user.stripe_customer_id;
    if (!cid) {
      const c = await stripe.customers.create({ email: user.email, name: user.business_name, metadata: { userId } });
      cid = c.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [cid, userId]);
    }
    const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at).getTime() : 0;

    // FIX [2a]: Don't put auth tokens in Stripe redirect URLs.
    // Dashboard should use a session cookie or re-auth flow instead.
    const session = await stripe.checkout.sessions.create({
      customer: cid,
      payment_method_types: ['card'],
      line_items: [{ price: planCfg.priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://calllocally.com/dashboard?upgraded=1&userId=${userId}`,
      cancel_url: `https://calllocally.com/dashboard?cancelled=1&userId=${userId}`,
      metadata: { userId, plan },
      ...(trialEnd > Date.now() ? {
        subscription_data: { metadata: { userId, plan }, trial_end: Math.floor(trialEnd / 1000) }
      } : {}),
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/api/billing-portal', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { userId, authToken } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1 AND auth_token=$2', [userId, authToken]);
    if (!rows.length) return res.status(401).json({ error: 'Unauthorized' });
    const user = rows[0];
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'No billing account' });

    const s = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `https://calllocally.com/dashboard?userId=${userId}`,
    });
    res.json({ url: s.url });
  } catch (err) {
    console.error('Billing portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ââ STRIPE WEBHOOK (idempotent) ââ
app.post('/api/stripe-webhook', async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) { return res.status(400).send(`Webhook error: ${err.message}`); }

  try {
    // Idempotency
    const dup = await pool.query('SELECT event_id FROM processed_stripe_events WHERE event_id=$1', [event.id]);
    if (dup.rows.length) return res.json({ received: true, duplicate: true });
    await pool.query('INSERT INTO processed_stripe_events (event_id) VALUES ($1)', [event.id]);

    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const { userId, plan } = s.metadata || {};
        if (userId) {
          await pool.query('UPDATE users SET paid=TRUE, plan=$1, stripe_subscription_id=$2 WHERE id=$3',
            [plan, s.subscription, userId]);
          // FIX [7c]: Wrap email in try/catch so it doesn't prevent webhook ack
          try {
            const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
            if (rows.length) await sendUpgradeEmail(rows[0], plan);
          } catch (emailErr) {
            console.error('Upgrade email failed (payment still processed):', emailErr.message);
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await pool.query('UPDATE users SET paid=$1, plan=$2 WHERE stripe_subscription_id=$3',
          [['active', 'trialing', 'past_due'].includes(sub.status), sub.metadata?.plan || null, sub.id]);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const paidThrough = new Date(sub.current_period_end * 1000);
        await pool.query('UPDATE users SET paid=FALSE, plan=NULL, paid_through=$1 WHERE stripe_subscription_id=$2',
          [paidThrough, sub.id]);
        try {
          const { rows } = await pool.query('SELECT * FROM users WHERE stripe_subscription_id=$1', [sub.id]);
          if (rows.length) await sendCancellationEmail(rows[0], paidThrough.toISOString());
        } catch (emailErr) {
          console.error('Cancellation email failed:', emailErr.message);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        try {
          const { rows } = await pool.query('SELECT * FROM users WHERE stripe_customer_id=$1', [inv.customer]);
          if (rows.length) await sendPaymentFailedEmail(rows[0]);
        } catch (emailErr) {
          console.error('Payment failed email error:', emailErr.message);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Stripe webhook processing error:', err.message);
    // Still return 200 â we've recorded the event ID, and returning 4xx/5xx
    // causes Stripe to retry, which could double-process
  }
  res.json({ received: true });
});


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// CALL FLOW â TWILIO WEBHOOKS
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// ââ VOICEMAIL RECORDING COMPLETE ââ
app.post('/api/voicemail', validateTwilio, async (req, res) => {
  try {
    const { RecordingUrl, RecordingDuration, Called, To: ToVM, Caller, RecordingSid } = req.body;
    const calledNumber = Called || ToVM;
    if (!RecordingUrl || !calledNumber) return res.status(200).send('OK');

    const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [calledNumber]);
    const user = rows[0];
    if (!user || !isActive(user)) return res.status(200).send('OK');

    const duration = parseInt(RecordingDuration) || 0;
    if (duration < 2) return res.status(200).send('OK');

    // Check for existing pending lead from this caller (not 'waiting' â status is 'pending')
    // FIX [3 race condition]: Match on 'pending' status, not 'waiting' (which doesn't exist)
    const existingLead = await pool.query(`
      SELECT id FROM leads WHERE user_id=$1 AND caller_phone=$2 AND status='pending'
      AND created_at > NOW() - INTERVAL '24 hours'
    `, [user.id, Caller]);

    if (!existingLead.rows.length) {
      await pool.query(`
        INSERT INTO leads (id, user_id, caller_phone, after_hours, status, service, sent_from)
        VALUES ($1,$2,$3,$4,'captured','Voicemail left',$5)
      `, [uuidv4(), user.id, Caller, !isBusinessHours(user), getSenderNumber(user)]);
      await pool.query('UPDATE users SET total_leads = total_leads + 1 WHERE id=$1', [user.id]);
    } else {
      await pool.query(`
        UPDATE leads SET status='captured', captured_at=NOW(), service='Voicemail left'
        WHERE id=$1
      `, [existingLead.rows[0].id]);
      await pool.query('UPDATE users SET total_leads = total_leads + 1 WHERE id=$1', [user.id]);
    }

    // Notify contractor via SMS
    const durMins = Math.floor(duration / 60);
    const durSecs = duration % 60;
    const durStr = durMins > 0 ? `${durMins}m ${durSecs}s` : `${durSecs}s`;
    const sms = `ð± Voicemail from ${Caller} (${durStr})\nListen: ${RecordingUrl}.mp3`;
    try {
      await smsCreate({ body: sms, from: getSenderNumber(user), to: user.business_phone });
      if (user.plan === 'team' && Array.isArray(user.team_phones)) {
        for (const phone of user.team_phones) {
          try { await smsCreate({ body: sms, from: getSenderNumber(user), to: phone }); } catch (e) { }
        }
      }
    } catch (e) { console.error('Voicemail SMS:', e.message); }

    // Email with playback link
    if (process.env.SENDGRID_API_KEY && user.email) {
      try {
        await sgMail.send({
          to: user.email, from: 'hello@calllocally.com',
          subject: `ð± Voicemail from ${Caller} (${durStr})`,
          html: `<div style="font-family:sans-serif;max-width:480px">
            <h2 style="color:#FF5C1A">New Voicemail</h2>
            <p><b>From:</b> ${Caller}</p>
            <p><b>Duration:</b> ${durStr}</p>
            <a href="${RecordingUrl}.mp3" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">â¶ Play Voicemail</a>
            <p style="margin-top:16px;font-size:13px;color:#888">You can also call back: <a href="tel:${Caller}">${Caller}</a></p>
          </div>`,
        });
      } catch (e) { console.error('Voicemail email:', e.message); }
    }
  } catch (err) {
    console.error('Voicemail handler error:', err.message);
  }
  res.status(200).send('OK');
});

// ââ CALL FORWARDING ââ
// FIX [2c]: Added validateTwilio + twilioWebhookLimiter
// FIX [7b]: Wrapped in try/catch with TwiML error fallback
app.post('/api/forward', twilioWebhookLimiter, validateTwilio, async (req, res) => {
  res.set('Content-Type', 'text/xml');
  try {
    const calledNum = req.body.To || req.body.Called;
    const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [calledNum]);
    const user = rows[0];

    if (!user) return res.send('<?xml version="1.0"?><Response><Say>This number is not configured.</Say></Response>');
    if (!isActive(user)) return res.send('<?xml version="1.0"?><Response><Say>This service is temporarily inactive.</Say></Response>');

    res.send(`<?xml version="1.0"?><Response>
      <Dial timeout="15" action="${RAILWAY_URL}/api/dial-complete" method="POST">
        ${user.business_phone}
      </Dial>
    </Response>`);
  } catch (err) {
    console.error('Forward error:', err.message);
    twimlError(res, 'Sorry, we are experiencing technical difficulties. Please try again later.');
  }
});

// ââ DIAL COMPLETE ââ
// FIX [2c]: Added validateTwilio + twilioWebhookLimiter
// FIX [7b]: Wrapped in try/catch with TwiML error fallback
app.post('/api/dial-complete', twilioWebhookLimiter, validateTwilio, async (req, res) => {
  res.set('Content-Type', 'text/xml');
  try {
    const { DialCallStatus, From, To, Called } = req.body;
    const calledNum = To || Called;
    const callerNum = From;

    // Contractor answered â done
    if (DialCallStatus === 'completed') {
      return res.send('<?xml version="1.0"?><Response><Hangup/></Response>');
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [calledNum]);
    const user = rows[0];
    if (!user || !isActive(user)) {
      return res.send('<?xml version="1.0"?><Response><Say>Sorry, this number is unavailable.</Say><Hangup/></Response>');
    }

    const isAH = !isBusinessHours(user);
    const senderNumber = getSenderNumber(user);

    // Send lead capture SMS to caller
    const defaultMsg = getTradeMessage(user.business_name, user.trade || 'general', isAH);
    const message = isAH ? (user.after_hours_message || defaultMsg) : (user.custom_message || defaultMsg);
    try {
      await smsCreate({ body: message, from: senderNumber, to: callerNum });

      // FIX [1d/4]: Store sent_from so replies to admin number can be routed correctly
      // FIX [6a]: ON CONFLICT uses the new partial unique index on (user_id, caller_phone) WHERE status='pending'
      await pool.query(`
        INSERT INTO leads (id, user_id, caller_phone, after_hours, status, sent_from)
        VALUES ($1,$2,$3,$4,'pending',$5)
        ON CONFLICT (user_id, caller_phone) WHERE status = 'pending' DO NOTHING
      `, [uuidv4(), user.id, callerNum, isAH, senderNumber]);

      // total_leads NOT incremented yet â only when customer replies
      console.log(`Lead SMS sent (pending reply): ${callerNum} â ${user.business_name}`);
    } catch (e) { console.error('Lead SMS error:', e.message); }

    // Play voicemail greeting and record
    const vmGreeting = user.custom_message
      ? `Please leave a voicemail or text this number your service need and address.`
      : isAH
        ? `Hi, you've reached ${user.business_name}. We're closed right now. Please leave a voicemail or text this number your service need and we'll call you back in the morning.`
        : `Hi, you've reached ${user.business_name}. We're on a job. Please leave a voicemail or text this number your service need and address and we'll call you right back.`;

    res.send(`<?xml version="1.0"?><Response>
      <Say voice="Polly.Joanna">${vmGreeting}</Say>
      <Record maxLength="120" playBeep="true" action="${RAILWAY_URL}/api/voicemail" timeout="5" finishOnKey="#"/>
      <Say voice="Polly.Joanna">We did not receive a recording. Goodbye.</Say>
    </Response>`);
  } catch (err) {
    console.error('Dial-complete error:', err.message);
    twimlError(res);
  }
});

// ââ CALL STATUS (safety valve â no longer sends SMS or creates leads) ââ
// FIX [1b/1c]: Gutted this handler. It was double-sending SMS and double-creating leads.
// /api/dial-complete already handles the missed-call flow. This is kept only for logging.
app.post('/api/call-status', validateTwilio, async (req, res) => {
  const { DialCallStatus, Caller, Called } = req.body;
  if (DialCallStatus && ['no-answer', 'busy', 'failed'].includes(DialCallStatus)) {
    console.log(`Call status: ${DialCallStatus} from ${Caller} to ${Called} (handled by dial-complete)`);
  }
  res.status(200).send('OK');
});


// ââ INCOMING SMS (customer reply) ââ
// FIX [1d/4]: Handles replies to BOTH the contractor's number AND the admin fallback number
app.post('/api/twilio/sms', validateTwilio, async (req, res) => {
  try {
    const { From, To, Body } = req.body;
    const xmlEscape = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // ── CONTRACTOR REPLY BRIDGE ──
    // If sender is a known contractor (business_phone or team_phones entry) texting
    // their own CallLocally number (or the admin fallback while TFV is pending),
    // relay to their most recent captured lead so the customer sees one thread.
    let bridgeQuery, bridgeParams;
    if (To === ADMIN_TWILIO_NUMBER) {
      bridgeQuery = `SELECT id, business_name, twilio_number, business_phone
        FROM users
        WHERE (business_phone=$1 OR $1 = ANY(COALESCE(team_phones, ARRAY[]::text[])))
          AND (tfv_notified IS NOT TRUE OR tfv_notified IS NULL)
        ORDER BY created_at DESC LIMIT 1`;
      bridgeParams = [From];
    } else {
      bridgeQuery = `SELECT id, business_name, twilio_number, business_phone
        FROM users
        WHERE twilio_number=$1
          AND (business_phone=$2 OR $2 = ANY(COALESCE(team_phones, ARRAY[]::text[])))
        LIMIT 1`;
      bridgeParams = [To, From];
    }
    const bridgeRes = await pool.query(bridgeQuery, bridgeParams);
    if (bridgeRes.rows.length > 0) {
      const contractor = bridgeRes.rows[0];
      const leadLookup = await pool.query(
        `SELECT id, caller_phone, sent_from FROM leads
         WHERE user_id=$1 AND status='captured' AND captured_at > NOW() - INTERVAL '48 hours'
         ORDER BY captured_at DESC LIMIT 1`,
        [contractor.id]
      );
      res.set('Content-Type', 'text/xml');
      if (leadLookup.rows.length === 0) {
        return res.send(`<?xml version="1.0"?><Response><Message>CallLocally: no recent customer reply to relay. New leads will appear here when customers text in.</Message></Response>`);
      }
      const lead = leadLookup.rows[0];
      const senderNum = (contractor.twilio_number && lead.sent_from !== ADMIN_TWILIO_NUMBER)
        ? contractor.twilio_number
        : (lead.sent_from || ADMIN_TWILIO_NUMBER);
      try {
        await smsCreate({
          body: Body.slice(0, 1500),
          from: senderNum,
          to: lead.caller_phone
        });
        await pool.query(
          `UPDATE leads SET conversation = COALESCE(conversation, '[]'::jsonb) || $1::jsonb WHERE id=$2`,
          [JSON.stringify([{ from: 'contractor', body: Body.slice(0, 1500), at: new Date().toISOString() }]), lead.id]
        );
        console.log(`Bridge relay: ${contractor.business_name} -> ${lead.caller_phone}`);
      } catch (e) {
        console.error('Bridge relay error:', e.message);
        try {
          await smsCreate({
            body: `CallLocally: couldn't relay that message to ${lead.caller_phone}. Please text them directly.`,
            from: senderNum, to: From
          });
        } catch (e2) { console.error('Bridge error-notify failed:', e2.message); }
      }
      return res.send(`<?xml version="1.0"?><Response></Response>`);
    }

    // ── CUSTOMER REPLY (existing flow) ──
    let leadRes;
    if (To === ADMIN_TWILIO_NUMBER) {
      leadRes = await pool.query(`
        SELECT l.*, u.id as uid, u.business_name, u.business_phone, u.twilio_number as user_twilio,
               u.email, u.plan, u.team_phones, u.trade, u.paid, u.paid_through, u.trial_ends_at,
               u.tfv_notified, u.total_leads, u.total_urgent, u.carrier,
               u.custom_message, u.after_hours_message, u.business_hours, u.timezone
        FROM leads l
        JOIN users u ON l.user_id = u.id
        WHERE l.caller_phone=$1 AND l.status='pending' AND l.sent_from=$2
        ORDER BY l.created_at DESC LIMIT 1
      `, [From, ADMIN_TWILIO_NUMBER]);
    } else {
      leadRes = await pool.query(`
        SELECT l.*, u.id as uid, u.business_name, u.business_phone, u.twilio_number as user_twilio,
               u.email, u.plan, u.team_phones, u.trade, u.paid, u.paid_through, u.trial_ends_at,
               u.tfv_notified, u.total_leads, u.total_urgent, u.carrier,
               u.custom_message, u.after_hours_message, u.business_hours, u.timezone
        FROM leads l
        JOIN users u ON l.user_id = u.id
        WHERE l.caller_phone=$1 AND l.status='pending' AND u.twilio_number=$2
        ORDER BY l.created_at DESC LIMIT 1
      `, [From, To]);
    }

    const row = leadRes.rows[0];
    let reply = "Thanks — we got your message. We'll text back shortly.";

    if (row && isActive(row)) {
      const urgent = /urgent|emergency|asap|right now|leaking|flooding|no heat|no ac|burst|broken|fire|sparks|smoke|water everywhere/i.test(Body);
      const addrMatch = Body.match(/\d+\s+[\w\s]+(st|ave|rd|blvd|dr|ln|way|ct|pl|street|avenue|road|drive|lane|court|place|boulevard|parkway|pkwy|circle|cir|trail|trl)\b/i);

      // FIX [6d]: Cap conversation array size to prevent unbounded growth
      const conversation = [...(row.conversation || []), { from: 'caller', body: Body.slice(0, 500), at: new Date().toISOString() }].slice(-20);

      await pool.query(`
        UPDATE leads SET status='captured', captured_at=NOW(), urgent=$1,
          service=COALESCE(service,$2), address=COALESCE(address,$3), conversation=$4
        WHERE id=$5
      `, [urgent || row.urgent, Body.slice(0, 500), addrMatch ? addrMatch[0] : row.address, JSON.stringify(conversation), row.id]);

      // FIX: Increment total_urgent alongside total_leads when applicable
      if (urgent || row.urgent) {
        await pool.query('UPDATE users SET total_leads = total_leads + 1, total_urgent = COALESCE(total_urgent, 0) + 1 WHERE id=$1', [row.user_id]);
      } else {
        await pool.query('UPDATE users SET total_leads = total_leads + 1 WHERE id=$1', [row.user_id]);
      }

      // Build a user-like object for notifyContractor
      const userForNotify = {
        business_name: row.business_name,
        business_phone: row.business_phone,
        twilio_number: row.user_twilio,
        email: row.email,
        plan: row.plan,
        team_phones: row.team_phones,
        tfv_notified: row.tfv_notified,
      };
      const leadForNotify = {
        ...row,
        urgent: urgent || row.urgent,
        service: row.service || Body,
        address: addrMatch ? addrMatch[0] : row.address,
      };
      await notifyContractor(userForNotify, leadForNotify);

      reply = (urgent || row.urgent)
        ? `Got it — URGENT. ${row.business_name} is being notified right now and will text back shortly.`
        : `Thanks! ${row.business_name} got your message and will text back shortly with timing and pricing.`;
    }

    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0"?><Response><Message>${xmlEscape(reply)}</Message></Response>`);
  } catch (err) {
    console.error('SMS handler error:', err.message);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0"?><Response><Message>Thanks — we got your message.</Message></Response>`);
  }
});


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// DASHBOARD API
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    const { rows } = await pool.query(
      'SELECT * FROM leads WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500', [userId]);
    res.json(rows);
  } catch (err) {
    console.error('Leads fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

app.get('/api/user/:userId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const u = rows[0];
    // FIX [2b]: Also exclude stripe_subscription_id from response
    const { auth_token, stripe_customer_id, stripe_subscription_id, ...safe } = u;
    safe.active = isActive(u);
    res.json(safe);
  } catch (err) {
    console.error('User fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.patch('/api/user/:userId', requireAuth, async (req, res) => {
  try {
    const { customMessage, afterHoursMessage, businessHours, timezone, teamPhones } = req.body;
    await pool.query(`
      UPDATE users SET
        custom_message = COALESCE($1, custom_message),
        after_hours_message = COALESCE($2, after_hours_message),
        business_hours = COALESCE($3, business_hours),
        timezone = COALESCE($4, timezone),
        team_phones = COALESCE($5, team_phones)
      WHERE id=$6
    `, [customMessage || null, afterHoursMessage || null,
      businessHours ? JSON.stringify(businessHours) : null,
      timezone || null,
      teamPhones ? JSON.stringify(teamPhones) : null,
      req.params.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('User update error:', err.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ââ ADMIN: USER LIST ââ
app.get('/api/admin/users', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await pool.query(`
      SELECT id, name, email, business_name, business_phone, twilio_number, trade,
             created_at, trial_ends_at, plan, paid, paid_through, stripe_customer_id,
             tfv_notified, tfv_submission_failed
      FROM users ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Admin users error:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// EMAIL HELPERS
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function notifyContractor(user, lead) {
  const flag = lead.urgent ? 'ð¨ URGENT â ' : '';
  const sms = `${flag}New CallLocally lead:\nFrom: ${lead.caller_phone}\nService: ${lead.service || 'See reply'}\nAddress: ${lead.address || 'Not provided'}${lead.after_hours ? '\n⏰ After-hours' : ''}\n\nReply to this message to text them back — CallLocally will route it to the customer.`;
  try { await smsCreate({ body: sms, from: getSenderNumber(user), to: user.business_phone }); }
  catch (e) { console.error('Contractor SMS:', e.message); }
  if (user.plan === 'team' && Array.isArray(user.team_phones) && user.team_phones.length > 0) {
    for (const phone of user.team_phones) {
      try { await smsCreate({ body: sms, from: getSenderNumber(user), to: phone }); }
      catch (e) { console.error('Team SMS error:', e.message); }
    }
  }
  if (!process.env.SENDGRID_API_KEY || !user.email) return;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: `${flag}New lead from ${lead.caller_phone}`,
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#FF5C1A">${flag}New CallLocally Lead</h2>
        <p><b>Caller:</b> ${lead.caller_phone}</p>
        <p><b>Service:</b> ${lead.service || 'Not specified'}</p>
        <p><b>Address:</b> ${lead.address || 'Ask when you call'}</p>
        <p><b>Urgent:</b> ${lead.urgent ? 'Yes ð¨' : 'No'}</p>
        ${lead.after_hours ? '<p><b>â° After hours lead</b></p>' : ''}
        <a href="tel:${lead.caller_phone}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">ð Call back now</a>
      </div>`,
    });
  } catch (e) { console.error('Email:', e.message); }
}

async function sendWelcomeEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  const num = user.twilioNumber;
  // FIX [1g]: Use single source of truth for carrier codes
  const carrier = (user.carrier || 'other').toLowerCase();
  const ci = getCarrierInstructions(carrier, num);

  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: "You're signed up! Your CallLocally number is being verified",
      html: `<div style="font-family:sans-serif;max-width:520px;color:#1a1a1a">
        <h2 style="color:#FF5C1A">Welcome, ${user.name}! ð</h2>
        <p style="font-size:16px">Your CallLocally number is ready:</p>
        <p style="font-size:36px;font-weight:700;color:#FF5C1A;letter-spacing:2px;margin:8px 0">${num}</p>
        <p style="color:#555;font-size:14px">Callers can text or leave a voicemail at this number. Both get delivered to you instantly.</p>

        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">

        <h3 style="margin-bottom:8px">Last step â forward your unanswered calls</h3>
        <p style="color:#555;margin-bottom:20px;font-size:14px">Dial the code below from your ${ci.name} phone and press <b>Call</b>. Your phone still rings normally â if you don't pick up, the caller can leave a voicemail <i>or</i> text back. Either way, you get notified instantly.</p>

        <div style="background:#fff8f5;border:2px solid #FF5C1A;border-radius:12px;padding:24px;text-align:center;margin-bottom:16px">
          <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#FF5C1A;margin-bottom:10px">Dial this on your ${ci.name} phone</p>
          <p style="font-size:32px;font-weight:700;font-family:monospace;color:#1a1a1a;letter-spacing:3px;margin:0">${ci.dialCode}</p>
          <p style="font-size:13px;color:#888;margin-top:10px">Then press <b>Call</b>. Done.</p>
          ${ci.extra}
        </div>

        <div style="background:#f9f9f9;border-radius:8px;padding:14px;margin-bottom:20px">
          <p style="font-size:13px;color:#555;margin:0">
            <b>How it works after setup:</b><br>
            1. Customer calls your regular number → rings you for 18 seconds<br>
            2. If no answer → they get a text from your CallLocally number asking what they need<br>
            3. When they reply, we text YOU their name, service, and address<br>
            4. Just hit reply on that text and we'll send it through to the customer — they see your whole conversation as one thread<br><br>
            <b>To turn off forwarding later:</b> Dial <code>##61#</code> and press Call.
          </p>
        </div>

        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="font-size:13px;color:#999">Questions? Reply to this email or reach us at hello@calllocally.com</p>
      </div>`,
    });
  } catch (e) { console.error('Welcome email:', e.message); }
}

async function sendUpgradeEmail(user, plan) {
  if (!process.env.SENDGRID_API_KEY) return;
  const planName = PLANS[plan]?.name || plan;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: `You're on CallLocally ${planName} â`,
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#FF5C1A">You're on ${planName}!</h2>
        <p>Hey ${user.name}, your ${planName} plan is active. Your number <b>${user.twilio_number}</b> is capturing leads.</p>
      </div>`,
    });
  } catch (e) { console.error('Upgrade email:', e.message); }
}

async function sendCancellationEmail(user, paidThrough) {
  if (!process.env.SENDGRID_API_KEY) return;
  const endDate = new Date(paidThrough).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: 'Your CallLocally subscription has been cancelled',
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2>Subscription cancelled</h2>
        <p>Hey ${user.name}, your subscription is cancelled. Service continues until <b>${endDate}</b>.</p>
        <p><a href="https://calllocally.com/dashboard">Reactivate anytime â</a></p>
      </div>`,
    });
  } catch (e) { console.error('Cancel email:', e.message); }
}

async function sendPaymentFailedEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: 'â ï¸ Payment failed â update your card',
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2>Payment failed</h2>
        <p>Hey ${user.name}, please update your payment method to keep your number active.</p>
        <a href="https://calllocally.com/dashboard" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">Update payment â</a>
      </div>`,
    });
  } catch (e) { console.error('Payment failed email:', e.message); }
}

async function sendTrialEmail(user, daysLeft) {
  if (!process.env.SENDGRID_API_KEY) return;
  const link = `https://calllocally.com/dashboard?userId=${user.id}`;
  const configs = {
    7: { subject: 'â° 7 days left on your CallLocally trial', body: `<p>Hey ${user.name}, 7 days left. Solo is $49/mo â <a href="${link}">upgrade now</a>.</p>` },
    1: { subject: 'â ï¸ Your trial ends tomorrow', body: `<p>Hey ${user.name}, trial ends tomorrow. <a href="${link}">Upgrade now â</a></p>` },
    0: { subject: 'Your CallLocally trial has ended', body: `<p>Hey ${user.name}, trial ended. <a href="${link}">Reactivate â</a></p>` },
  };
  if (!configs[daysLeft]) return;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com', subject: configs[daysLeft].subject,
      html: `<div style="font-family:sans-serif;max-width:480px">${configs[daysLeft].body}</div>`
    });
  } catch (e) { console.error('Trial email:', e.message); }
}

async function sendVerifiedEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  const num = user.twilio_number;
  // FIX [1g]: Use single source of truth for carrier codes
  const carrier = (user.carrier || 'other').toLowerCase();
  const ci = getCarrierInstructions(carrier, num);

  try {
    await sgMail.send({
      to: user.email,
      from: 'hello@calllocally.com',
      subject: 'â Your CallLocally number is verified â finish setup in 1 minute',
      html: `<div style="font-family:sans-serif;max-width:520px;color:#1a1a1a">
        <h2 style="color:#FF5C1A">You're verified! Last step ð</h2>
        <p style="font-size:16px">Your CallLocally number is approved and ready to receive texts:</p>
        <p style="font-size:36px;font-weight:700;color:#FF5C1A;letter-spacing:2px;margin:8px 0">${num}</p>

        <p style="color:#555;font-size:14px;margin-bottom:20px">Now just forward your unanswered calls to this number. Takes 1 minute. Your phone still rings normally â if you don't pick up, the caller hears a greeting and can leave a voicemail or text.</p>

        <div style="background:#fff8f5;border:2px solid #FF5C1A;border-radius:12px;padding:24px;text-align:center;margin-bottom:16px">
          <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#FF5C1A;margin-bottom:10px">Dial this on your ${ci.name} phone</p>
          <p style="font-size:32px;font-weight:700;font-family:monospace;color:#1a1a1a;letter-spacing:3px;margin:0">${ci.dialCode}</p>
          <p style="font-size:13px;color:#888;margin-top:10px">Then press <b>Call</b>. Done.</p>
          ${ci.extra}
        </div>

        <div style="background:#f9f9f9;border-radius:8px;padding:14px;margin-bottom:20px">
          <p style="font-size:13px;color:#555;margin:0">
            <b>To undo forwarding later:</b> Dial <code>##61#</code> and press Call.<br><br>
            <b>What happens after setup:</b><br>
            1. Customer calls your real number â rings you for 18 seconds<br>
            2. If no answer â they hear your voicemail greeting<br>
            3. They leave a voicemail or text back<br>
            4. You get notified instantly via SMS and email
          </p>
        </div>

        <a href="https://calllocally.com/dashboard?userId=${user.id}" style="display:inline-block;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">Go to Dashboard â</a>
        <p style="font-size:13px;color:#999;margin-top:16px">Questions? Reply to this email or reach us at hello@calllocally.com</p>
      </div>`,
    });
    console.log(`Verified email sent to ${user.email}`);
  } catch (e) { console.error('Verified email error:', e.message); }

  // Also text them â contractors check phone first
  if (user.business_phone && user.twilio_number) {
    // FIX [1g]: Use getCarrierInstructions for SMS too
    try {
      await smsCreate({
        body: `â Your CallLocally number is verified and ready! One last step: dial ${ci.dialCode} from your phone, press Call. That's it â missed calls will now be captured automatically. Questions? Reply to this text.`,
        from: getSenderNumber(user),
        to: user.business_phone
      });
    } catch (e) { console.error('Verified SMS error:', e.message); }
  }
}


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// TFV WEBHOOK + POLLER
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// ââ TFV STATUS WEBHOOK ââ
// FIX [2d]: Added basic authentication for TFV webhook
// Twilio doesn't sign these the same way as call/SMS webhooks, so we use a shared secret
app.post('/api/tfv-webhook', async (req, res) => {
  // Verify webhook authenticity via shared secret header or Twilio signature
  const webhookSecret = process.env.TFV_WEBHOOK_SECRET;
  if (webhookSecret) {
    const providedSecret = req.headers['x-tfv-secret'] || req.query.secret;
    if (providedSecret !== webhookSecret) {
      console.warn('Invalid TFV webhook secret from', req.ip);
      return res.status(403).send('Forbidden');
    }
  } else {
    // Fallback: validate Twilio signature if no dedicated secret is set
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const signature = req.headers['x-twilio-signature'];
    if (signature) {
      const url = `${RAILWAY_URL}${req.originalUrl}`;
      const isValid = twilio.validateRequest(authToken, signature, url, req.body || {});
      if (!isValid) {
        console.warn('Invalid Twilio signature on TFV webhook from', req.ip);
        return res.status(403).send('Forbidden');
      }
    } else {
      console.warn('TFV webhook received without authentication â set TFV_WEBHOOK_SECRET env var');
    }
  }

  const { TollfreePhoneNumber, Status } = req.body;
  res.sendStatus(200); // Always ack immediately

  if (!TollfreePhoneNumber || !Status) return;

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [TollfreePhoneNumber]);
    const user = rows[0];
    if (!user) return;

    if (Status === 'TWILIO_APPROVED') {
      // FIX [5 race]: Use a CAS-style update to prevent double-processing
      const updateResult = await pool.query(
        'UPDATE users SET trial_ends_at=$1, tfv_notified=TRUE WHERE id=$2 AND tfv_notified IS NOT TRUE RETURNING id',
        [new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), user.id]
      );
      if (updateResult.rows.length === 0) {
        console.log(`TFV approval for ${TollfreePhoneNumber} already processed â skipping`);
        return;
      }
      console.log(`TFV approved for ${TollfreePhoneNumber} (user: ${user.email})`);
      const fresh = (await pool.query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0] || user;
      await sendVerifiedEmail(fresh);
    } else if (Status === 'TWILIO_REJECTED') {
      await pool.query('UPDATE users SET tfv_notified=TRUE WHERE id=$1 AND tfv_notified IS NOT TRUE', [user.id]);
      console.log(`TFV rejected for ${TollfreePhoneNumber} (user: ${user.email})`);
      if (process.env.SENDGRID_API_KEY) {
        try {
          await sgMail.send({
            to: user.email, from: 'hello@calllocally.com',
            subject: 'Action needed: your CallLocally number verification',
            html: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#FF5C1A">Verification needs attention</h2><p>Hey ${user.name}, there was an issue verifying your number. Our team will reach out within 1 business day.</p></div>`
          });
        } catch (e) { console.error('Rejection email:', e.message); }
      }
    }
  } catch (err) {
    console.error('TFV webhook processing error:', err.message);
  }
});


// ââ TFV STATUS POLLER ââ
// FIX [1a/8a]: Single definition, single setInterval/setTimeout
async function checkTFVStatus() {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE twilio_number IS NOT NULL AND (tfv_notified IS NOT TRUE OR tfv_notified IS NULL) AND paid = FALSE"
    );
    if (!rows.length) return;
    const auth = 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');

    for (const user of rows) {
      try {
        const r = await fetch(`https://messaging.twilio.com/v1/Tollfree/Verifications?TollfreePhoneNumber=${encodeURIComponent(user.twilio_number)}`, { headers: { 'Authorization': auth } });

        // FIX [8d]: Handle Twilio API errors gracefully
        if (!r.ok) {
          console.error(`TFV API error for ${user.twilio_number}: HTTP ${r.status}`);
          continue; // Skip this user, try again next cycle
        }

        const d = await r.json();
        const v = d.verifications?.[0];
        if (!v) continue;

        if (v.status === 'TWILIO_APPROVED') {
          // FIX [5 race]: CAS-style update to prevent double-processing with webhook
          const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
          const updateResult = await pool.query(
            'UPDATE users SET tfv_notified=TRUE, trial_ends_at=$2 WHERE id=$1 AND tfv_notified IS NOT TRUE RETURNING id',
            [user.id, trialEnd]
          );
          if (updateResult.rows.length === 0) {
            console.log(`TFV for ${user.twilio_number} already handled â skipping`);
            continue;
          }
          const fresh = (await pool.query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0] || user;
          await sendVerifiedEmail(fresh);
          console.log(`TFV approved + trial started: ${user.twilio_number}`);
        } else if (v.status === 'TWILIO_REJECTED') {
          await pool.query('UPDATE users SET tfv_notified=TRUE WHERE id=$1 AND tfv_notified IS NOT TRUE', [user.id]);
          if (process.env.SENDGRID_API_KEY) {
            try {
              await sgMail.send({
                to: user.email, from: 'hello@calllocally.com',
                subject: 'Action needed: your CallLocally number verification',
                html: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#FF5C1A">Verification needs attention</h2><p>Hey ${user.name}, there was an issue verifying your number. Our team will reach out within 1 business day.</p></div>`
              });
            } catch (e) { console.error('Rejection email:', e.message); }
          }
        }
      } catch (e) { console.error(`TFV check ${user.twilio_number}:`, e.message); }
    }
  } catch (e) { console.error('TFV poller error:', e.message); }
}

// ââ TRIAL CHECK ââ
// FIX [8b]: Add LIMIT to avoid fetching entire user table at scale
async function checkTrials() {
  try {
    const { rows } = await pool.query(`
      SELECT * FROM users
      WHERE paid=FALSE AND trial_ends_at IS NOT NULL
      ORDER BY trial_ends_at ASC
      LIMIT 500
    `);
    for (const user of rows) {
      const daysLeftRaw = Math.ceil((new Date(user.trial_ends_at) - Date.now()) / 86400000);
      const daysLeft = daysLeftRaw < 0 ? 0 : daysLeftRaw;
      if ([7, 1, 0].includes(daysLeft) && user.last_trial_notification !== daysLeft) {
        await sendTrialEmail(user, daysLeft);
        if (daysLeft === 0 && user.twilio_number && user.business_phone) {
          try {
            await smsCreate({
              body: `â° Your CallLocally trial has ended. Don't lose your leads â upgrade at calllocally.com/dashboard. Solo plan is just $49/mo. Questions? Reply here.`,
              from: getSenderNumber(user),
              to: user.business_phone
            });
          } catch (e) { console.error('Trial-end SMS error:', e.message); }
        }
        await pool.query('UPDATE users SET last_trial_notification=$1 WHERE id=$2', [daysLeft, user.id]);
      }
    }
  } catch (e) { console.error('Trial check error:', e.message); }
}

// FIX [1a/8a]: Single setInterval/setTimeout for each cron â no duplicates
setInterval(checkTFVStatus, 60 * 60 * 1000);
setTimeout(checkTFVStatus, 15000);

setInterval(checkTrials, 60 * 60 * 1000);
setTimeout(checkTrials, 8000);


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// ANALYTICS (Admin)
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/api/admin/analytics', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });

  try {
    const [usersR, leadsR, revenueR] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) as total_users,
          COUNT(*) FILTER (WHERE paid = TRUE) as paid_users,
          COUNT(*) FILTER (WHERE paid = FALSE AND trial_ends_at > NOW()) as trial_users,
          COUNT(*) FILTER (WHERE paid = FALSE AND trial_ends_at < NOW()) as expired_users,
          COUNT(*) FILTER (WHERE plan = 'solo') as solo_count,
          COUNT(*) FILTER (WHERE plan = 'growth') as growth_count,
          COUNT(*) FILTER (WHERE plan = 'team') as team_count,
          COUNT(*) FILTER (WHERE trade = 'plumbing') as plumbing,
          COUNT(*) FILTER (WHERE trade = 'hvac') as hvac,
          COUNT(*) FILTER (WHERE trade = 'electrical') as electrical,
          COUNT(*) FILTER (WHERE trade = 'roofing') as roofing,
          COUNT(*) FILTER (WHERE trade = 'landscaping') as landscaping,
          COUNT(*) FILTER (WHERE trade = 'pest') as pest,
          COUNT(*) FILTER (WHERE trade = 'handyman') as handyman,
          COUNT(*) FILTER (WHERE trade = 'painting') as painting,
          COUNT(*) FILTER (WHERE trade = 'pool') as pool_trade,
          COUNT(*) FILTER (WHERE trade = 'general') as other_trade,
          SUM(total_leads) as total_leads_all_time,
          SUM(total_urgent) as total_urgent_all_time
        FROM users
      `),
      pool.query(`
        SELECT
          COUNT(*) as total_leads,
          COUNT(*) FILTER (WHERE status = 'captured') as captured,
          COUNT(*) FILTER (WHERE status = 'pending') as pending,
          COUNT(*) FILTER (WHERE urgent = TRUE) as urgent,
          COUNT(*) FILTER (WHERE after_hours = TRUE) as after_hours,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7_days,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as last_30_days
        FROM leads
      `),
      pool.query(`
        SELECT
          COALESCE(SUM(CASE plan WHEN 'solo' THEN 49 WHEN 'growth' THEN 79 WHEN 'team' THEN 129 ELSE 0 END), 0) as mrr
        FROM users WHERE paid = TRUE
      `),
    ]);

    const users = usersR.rows[0];
    const leads = leadsR.rows[0];
    const revenue = revenueR.rows[0];

    res.json({
      users: {
        total: parseInt(users.total_users),
        paid: parseInt(users.paid_users),
        trial: parseInt(users.trial_users),
        expired: parseInt(users.expired_users),
        byPlan: { solo: parseInt(users.solo_count), growth: parseInt(users.growth_count), team: parseInt(users.team_count) },
        byTrade: {
          plumbing: parseInt(users.plumbing), hvac: parseInt(users.hvac), electrical: parseInt(users.electrical),
          roofing: parseInt(users.roofing), landscaping: parseInt(users.landscaping), pest: parseInt(users.pest),
          handyman: parseInt(users.handyman), painting: parseInt(users.painting), pool: parseInt(users.pool_trade),
          other: parseInt(users.other_trade),
        },
      },
      leads: {
        total: parseInt(leads.total_leads),
        captured: parseInt(leads.captured),
        pending: parseInt(leads.pending),
        urgent: parseInt(leads.urgent),
        afterHours: parseInt(leads.after_hours),
        last7Days: parseInt(leads.last_7_days),
        last30Days: parseInt(leads.last_30_days),
      },
      revenue: {
        mrr: parseInt(revenue.mrr),
        arr: parseInt(revenue.mrr) * 12,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Analytics error:', err.message);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// STATIC FILES
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

app.get('/dashboard', (req, res) => {
  const p = path.join(__dirname, 'public', 'dashboard.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(404).send('Not found');
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.send('CallLocally is running.');
});


// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// START
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const PORT = process.env.PORT || 3000;
// FIX [7e]: If DB init fails, do NOT start accepting traffic â crash and let Railway retry
initDB().then(() => {
  app.listen(PORT, () => console.log(`CallLocally running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed â NOT starting server:', err.message);
  process.exit(1);
});
