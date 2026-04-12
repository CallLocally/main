// ── TOLL-FREE VERIFICATION (auto-submit on signup) ──
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
    BusinessStreetAddress: '1234 Main St',
    BusinessCity: 'Los Angeles',
    BusinessStateProvinceRegion: 'CA',
    BusinessPostalCode: '90001',
    BusinessCountry: 'US',
    BusinessType: 'SOLE_PROPRIETOR',
    BusinessContactFirstName: firstName,
    BusinessContactLastName: lastName,
    BusinessContactEmail: user.email,
    BusinessContactPhone: user.businessPhone || user.business_phone || user.twilioNumber,
    UseCaseCategories: 'ACCOUNT_NOTIFICATIONS',
    UseCaseSummary: `CallLocally sends automated SMS to missed callers on behalf of ${biz}, a home service contractor. When a customer calls and gets no answer, CallLocally texts them to capture their service need and address. The contractor receives lead details via SMS and email. No marketing messages.`,
    ProductionMessageSample: `Hi! This is ${biz} — missed your call. What service do you need and what's your address?`,
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
    } else {
      console.error(`TFV failed for ${user.twilioNumber}:`, JSON.stringify(d));
    }
  } catch(e) {
    console.error('TFV submission error:', e.message);
  }
}

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

// ── SECURITY MIDDLEWARE ──
app.use(helmet({ contentSecurityPolicy: false })); // security headers
app.use(cors({ origin: ['https://calllocally.com', 'https://main-production-147d.up.railway.app'] }));

// Stripe webhook needs raw body — must be before express.json()
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' })); // cap payload size
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ── RATE LIMITING ──
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5, // 5 signups per IP per hour
  message: { error: 'Too many signups from this IP, try again later' },
  standardHeaders: true, legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://calllocally.com';
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  solo:   { name: 'Solo',   price: 4900,  priceId: process.env.STRIPE_PRICE_SOLO },
  growth: { name: 'Growth', price: 7900,  priceId: process.env.STRIPE_PRICE_GROWTH },
  team:   { name: 'Team',   price: 12900, priceId: process.env.STRIPE_PRICE_TEAM },
};

// ── POSTGRES ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
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
      carrier TEXT DEFAULT 'other'
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_phones JSONB DEFAULT '[]';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS total_leads INT DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS total_urgent INT DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS carrier TEXT DEFAULT 'other';
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      caller_phone TEXT NOT NULL,
      status TEXT DEFAULT 'waiting',
      service TEXT,
      address TEXT,
      urgent BOOLEAN DEFAULT FALSE,
      after_hours BOOLEAN DEFAULT FALSE,
      conversation JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      captured_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS processed_stripe_events (
      event_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS leads_user_id_idx ON leads(user_id);
    CREATE INDEX IF NOT EXISTS leads_caller_idx ON leads(caller_phone, status);
    CREATE INDEX IF NOT EXISTS users_twilio_idx ON users(twilio_number);
    CREATE INDEX IF NOT EXISTS users_stripe_customer_idx ON users(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS users_stripe_sub_idx ON users(stripe_subscription_id);
  `);
  console.log('DB initialized');
}

function formatPhone(raw) {
  const d = raw.replace(/\D/g,'');
  return d.startsWith('1') ? `+${d}` : `+1${d}`;
}
// ── TRADE-SPECIFIC MESSAGES ──
function getTradeMessage(businessName, trade, afterHours = false) {
  // If contractor has set a custom message, that takes priority (handled at call site)
  const biz = businessName;
  const ah = afterHours;
  const base = {
    plumbing:    ah ? `Hi! This is ${biz} — we're closed right now. What's the plumbing issue and your address? (e.g. leak, clog, no hot water) We'll call first thing in the morning.`
                    : `Hi! This is ${biz} — we're on a job. What's the plumbing issue and address? (e.g. burst pipe, clog, no hot water)`,
    hvac:        ah ? `Hi! This is ${biz} — we're closed. What's going on with your heating or AC, and what's your address? We'll call back in the morning.`
                    : `Hi! This is ${biz} — missed your call. What's the HVAC issue and address? (e.g. no heat, no AC, strange noise)`,
    electrical:  ah ? `Hi! This is ${biz} — we're closed. What's the electrical issue and your address? We call back emergencies 24/7 — reply URGENT if needed.`
                    : `Hi! This is ${biz} — on a job. What's the electrical issue and address? (e.g. outage, tripped breaker, new install)`,
    roofing:     ah ? `Hi! This is ${biz} — closed for the day. What roofing issue do you have and what's the address? We'll follow up in the morning.`
                    : `Hi! This is ${biz} — missed your call. Is this a repair, inspection, or replacement? And what's the property address?`,
    landscaping: ah ? `Hi! This is ${biz} — closed for the day. What service do you need and what's your address? (lawn care, trees, sprinklers, design)`
                    : `Hi! This is ${biz} — on a job. What landscaping service do you need and the address? (lawn, trees, sprinklers, cleanup)`,
    pest:        ah ? `Hi! This is ${biz} — closed right now. What pest issue are you dealing with and what's your address? We'll call back in the morning.`
                    : `Hi! This is ${biz} — missed your call. What pest issue are you having and what's the address? (e.g. ants, rodents, termites)`,
    handyman:    ah ? `Hi! This is ${biz} — closed for today. What do you need done and what's the address? We'll schedule you first thing tomorrow.`
                    : `Hi! This is ${biz} — on a job. What do you need fixed or built, and what's the address?`,
    painting:    ah ? `Hi! This is ${biz} — closed for the day. What painting project do you have in mind and what's the address?`
                    : `Hi! This is ${biz} — missed your call. Interior or exterior painting? And what's the address?`,
    pool:        ah ? `Hi! This is ${biz} — closed right now. What's the pool issue and your address? We'll follow up in the morning.`
                    : `Hi! This is ${biz} — on a job. What's the pool issue and address? (e.g. repair, cleaning, equipment, green water)`,
    general:     ah ? `Hi! This is ${biz} — we're closed. What service do you need and what's your address? We'll call back first thing in the morning.`
                    : `Hi! This is ${biz} — missed your call. What service do you need and what's your address?`,
  };
  return base[trade] || base.general;
}


function isActive(user) {
  if (user.paid) return true;
  if (user.paid_through && new Date(user.paid_through) > new Date()) return true;
  if (user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  return false;
}
function isBusinessHours(user) {
  if (!user.business_hours) return true;
  const now = new Date();
  const tz = user.timezone || 'America/Los_Angeles';
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const hour = local.getHours();
  const day = local.getDay();
  const { startHour=7, endHour=20, weekendOn=false } = user.business_hours;
  if (!weekendOn && (day===0||day===6)) return false;
  return hour >= startHour && hour < endHour;
}

// ── TWILIO SIGNATURE VALIDATION ──
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

// ── DASHBOARD AUTH ──
async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const userId = req.params.userId || req.query.userId;
  if (!token || !userId) return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT id FROM users WHERE id=$1 AND auth_token=$2', [userId, token]);
  if (!rows.length) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── SIGNUP ──
app.post('/api/signup', signupLimiter, async (req, res) => {
  const { name, email, businessName, businessPhone, trade, carrier } = req.body;
  if (!name || !email || !businessName || !businessPhone)
    return res.status(400).json({ error: 'All fields required' });

  // Sanitize email
  const cleanEmail = email.toLowerCase().trim().slice(0, 255);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail))
    return res.status(400).json({ error: 'Invalid email' });

  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [cleanEmail]);
  if (existing.rows.length) return res.status(400).json({ error: 'Email already registered' });

  const formattedPhone = formatPhone(businessPhone);

  try {
    // Provision toll-free number
    const tfAvail = await twilioClient.availablePhoneNumbers('US').tollFree.list({ limit: 1 });
    if (!tfAvail.length) throw new Error('No toll-free numbers available');
    const purchased = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: tfAvail[0].phoneNumber,
      voiceUrl: `${RAILWAY_URL}/api/forward`, voiceMethod: 'GET',
      statusCallback: `${RAILWAY_URL}/api/call-status`, statusCallbackMethod: 'POST',
      smsUrl: `${RAILWAY_URL}/api/twilio/sms`, smsMethod: 'POST',
    });

    const userId = uuidv4(); // secure random UUID
    const authToken = uuidv4(); // dashboard auth token
    const trialEndsAt = new Date(Date.now() + 14*24*60*60*1000);

    await pool.query(`
      INSERT INTO users (id, auth_token, name, email, business_name, business_phone, trade, twilio_number, custom_message, after_hours_message, trial_ends_at, carrier)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      userId, authToken, name.slice(0,100), cleanEmail, businessName.slice(0,200),
      formattedPhone, trade||'general', purchased.phoneNumber,
      null, null, trialEndsAt, carrier||'other',
    ]);

    await sendWelcomeEmail({ name, email: cleanEmail, businessName, twilioNumber: purchased.phoneNumber, id: userId, carrier: carrier||'other' });
    // Auto-submit toll-free verification — fire and forget, non-blocking
    submitTollFreeVerification({ name, email: cleanEmail, businessName, business_name: businessName, twilioNumber: purchased.phoneNumber, phoneSid: purchased.sid }).catch(e => console.error('TFV error:', e.message));
    console.log(`Signup: ${businessName} → ${purchased.phoneNumber}`);
    res.json({ success: true, userId, authToken, twilioNumber: purchased.phoneNumber });
  } catch(err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: CHECKOUT ──
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { userId, plan, authToken } = req.body;
  if (!userId || !PLANS[plan]) return res.status(400).json({ error: 'userId and plan required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1 AND auth_token=$2', [userId, authToken]);
  if (!rows.length) return res.status(401).json({ error: 'Unauthorized' });
  const user = rows[0];

  const planCfg = PLANS[plan];
  if (!planCfg.priceId) return res.status(500).json({ error: `Price ID for ${plan} not set` });

  try {
    let cid = user.stripe_customer_id;
    if (!cid) {
      const c = await stripe.customers.create({ email: user.email, name: user.business_name, metadata: { userId } });
      cid = c.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [cid, userId]);
    }
    const trialEnd = new Date(user.trial_ends_at).getTime();
    const session = await stripe.checkout.sessions.create({
      customer: cid,
      payment_method_types: ['card'],
      line_items: [{ price: planCfg.priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://calllocally.com/dashboard?upgraded=1&userId=${userId}&token=${user.auth_token}`,
      cancel_url: `https://calllocally.com/dashboard?cancelled=1&userId=${userId}&token=${user.auth_token}`,
      metadata: { userId, plan },
      ...(trialEnd > Date.now() ? {
        subscription_data: { metadata: { userId, plan }, trial_end: Math.floor(trialEnd/1000) }
      } : {}),
    });
    res.json({ url: session.url });
  } catch(err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: BILLING PORTAL ──
app.post('/api/billing-portal', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { userId, authToken } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1 AND auth_token=$2', [userId, authToken]);
  if (!rows.length) return res.status(401).json({ error: 'Unauthorized' });
  const user = rows[0];
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'No billing account' });
  try {
    const s = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `https://calllocally.com/dashboard?userId=${userId}&token=${user.auth_token}`,
    });
    res.json({ url: s.url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── STRIPE: WEBHOOK (idempotent) ──
app.post('/api/stripe-webhook', async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(err) { return res.status(400).send(`Webhook error: ${err.message}`); }

  // Idempotency — skip if already processed
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
        const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
        if (rows.length) await sendUpgradeEmail(rows[0], plan);
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      await pool.query('UPDATE users SET paid=$1, plan=$2 WHERE stripe_subscription_id=$3',
        [['active','trialing','past_due'].includes(sub.status), sub.metadata?.plan||null, sub.id]);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const paidThrough = new Date(sub.current_period_end * 1000);
      await pool.query('UPDATE users SET paid=FALSE, plan=NULL, paid_through=$1 WHERE stripe_subscription_id=$2',
        [paidThrough, sub.id]);
      const { rows } = await pool.query('SELECT * FROM users WHERE stripe_subscription_id=$1', [sub.id]);
      if (rows.length) await sendCancellationEmail(rows[0], paidThrough.toISOString());
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const { rows } = await pool.query('SELECT * FROM users WHERE stripe_customer_id=$1', [inv.customer]);
      if (rows.length) await sendPaymentFailedEmail(rows[0]);
      break;
    }
  }
  res.json({ received: true });
});


// ── VOICEMAIL RECORDING COMPLETE ──
app.post('/api/voicemail', validateTwilio, async (req, res) => {
  const { RecordingUrl, RecordingDuration, Called, To: ToVM, Caller, RecordingSid } = req.body;
  const calledNumber = Called || ToVM;
  if (!RecordingUrl || !calledNumber) return res.status(200).send('OK');

  const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [calledNumber]);
  const user = rows[0];
  if (!user || !isActive(user)) return res.status(200).send('OK');

  const duration = parseInt(RecordingDuration) || 0;
  if (duration < 2) return res.status(200).send('OK'); // skip accidental beep recordings

  // Insert lead for voicemail if no existing waiting lead from this caller
  const existingLead = await pool.query(`
    SELECT id FROM leads WHERE user_id=$1 AND caller_phone=$2 AND status='waiting'
    AND created_at > NOW() - INTERVAL '24 hours'
  `, [user.id, Caller]);

  if (!existingLead.rows.length) {
    await pool.query(`
      INSERT INTO leads (id, user_id, caller_phone, after_hours, status, service)
      VALUES ($1,$2,$3,$4,'captured','Voicemail left')
    `, [uuidv4(), user.id, Caller, !isBusinessHours(user)]);
    await pool.query('UPDATE users SET total_leads = total_leads + 1 WHERE id=$1', [user.id]);
  } else {
    await pool.query(`
      UPDATE leads SET status='captured', captured_at=NOW(), service='Voicemail left'
      WHERE id=$1
    `, [existingLead.rows[0].id]);
  }

  // Notify contractor via SMS
  const durMins = Math.floor(duration/60);
  const durSecs = duration % 60;
  const durStr = durMins > 0 ? `${durMins}m ${durSecs}s` : `${durSecs}s`;
  const sms = `📱 Voicemail from ${Caller} (${durStr})\nListen: ${RecordingUrl}.mp3`;
  try {
    await twilioClient.messages.create({ body: sms, from: user.twilio_number, to: user.business_phone });
    if (user.plan === 'team' && Array.isArray(user.team_phones)) {
      for (const phone of user.team_phones) {
        try { await twilioClient.messages.create({ body: sms, from: user.twilio_number, to: phone }); } catch(e) {}
      }
    }
  } catch(e) { console.error('Voicemail SMS:', e.message); }

  // Email with playback link
  if (process.env.SENDGRID_API_KEY && user.email) {
    try {
      await sgMail.send({
        to: user.email, from: 'hello@calllocally.com',
        subject: `📱 Voicemail from ${Caller} (${durStr})`,
        html: `<div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#FF5C1A">New Voicemail</h2>
          <p><b>From:</b> ${Caller}</p>
          <p><b>Duration:</b> ${durStr}</p>
          <a href="${RecordingUrl}.mp3" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">▶ Play Voicemail</a>
          <p style="margin-top:16px;font-size:13px;color:#888">You can also call back: <a href="tel:${Caller}">${Caller}</a></p>
        </div>`,
      });
    } catch(e) { console.error('Voicemail email:', e.message); }
  }
  res.status(200).send('OK');
});

// ── CALL FORWARDING ──
// Twilio hits this when someone calls the toll-free number (voiceUrl)
// Architecture: NO dial-back (avoids the busy loop when forwarding from same number)
// Instead: ring the contractor's phone via <Dial>, and if no answer,
// immediately play voicemail + send SMS. Clean, no loop possible.
app.post('/api/forward', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  const calledNum = req.body.To || req.body.Called;
  const callerNum = req.body.From || req.body.Caller;

  const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [calledNum]);
  const user = rows[0];

  if (!user) return res.send('<?xml version="1.0"?><Response><Say>This number is not configured.</Say><Hangup/></Response>');
  if (!isActive(user)) return res.send('<?xml version="1.0"?><Response><Say>This service is temporarily inactive.</Say><Hangup/></Response>');

  const isAH = !isBusinessHours(user);
  const vmGreeting = user.custom_message
    ? user.custom_message
    : isAH
      ? `Hi, you've reached ${user.business_name}. We're closed right now. Please leave a voicemail or text this number your service need and we'll call you back in the morning.`
      : `Hi, you've reached ${user.business_name}. We're on a job. Please leave a voicemail or text this number your service need and address and we'll call you right back.`;

  // Send lead capture SMS immediately — contractor knows someone called
  const defaultMsg = getTradeMessage(user.business_name, user.trade || 'general', isAH);
  const smsMsg = isAH ? (user.after_hours_message || defaultMsg) : (user.custom_message || defaultMsg);
  try {
    await twilioClient.messages.create({ body: smsMsg, from: user.twilio_number, to: callerNum });
    await pool.query('INSERT INTO leads (id, user_id, caller_phone, after_hours) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [uuidv4(), user.id, callerNum, isAH]);
    await pool.query('UPDATE users SET total_leads = total_leads + 1 WHERE id=$1', [user.id]);
    console.log(`Lead SMS sent: ${callerNum} → ${user.business_name} (${user.twilio_number})`);
  } catch(e) { console.error('Lead SMS error:', e.message); }

  // Play voicemail greeting and record
  res.send(`<?xml version="1.0"?><Response>
    <Say voice="Polly.Joanna">${vmGreeting}</Say>
    <Record maxLength="120" playBeep="true" action="${RAILWAY_URL}/api/voicemail" timeout="5" finishOnKey="#"/>
    <Say voice="Polly.Joanna">We did not receive a recording. Goodbye.</Say>
  </Response>`);
});

// ── CALL STATUS → SMS (Twilio-validated) ──
app.post('/api/call-status', validateTwilio, async (req, res) => {
  // Lead capture now handled by /api/dial-complete — this is a no-op safety valve
  const { DialCallStatus, Caller, Called } = req.body;
  if (!DialCallStatus || !Caller) return res.status(200).send('OK');
  // Only handle if dial-complete somehow missed it
  if (!['no-answer','busy','failed'].includes(DialCallStatus)) return res.status(200).send('OK');

  const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [Called]);
  const user = rows[0];
  if (!user || !isActive(user)) return res.status(200).send('OK');

  const afterHours = !isBusinessHours(user);
  // Use custom message if contractor set one, otherwise use trade-specific default
  const defaultMsg = getTradeMessage(user.business_name, user.trade || 'general', afterHours);
  const message = afterHours
    ? (user.after_hours_message || defaultMsg)
    : (user.custom_message || defaultMsg);

  try {
    await twilioClient.messages.create({ body: message, from: user.twilio_number, to: Caller });
    await pool.query(`
      INSERT INTO leads (id, user_id, caller_phone, after_hours)
      VALUES ($1,$2,$3,$4)
    `, [uuidv4(), user.id, Caller, afterHours]);
    await pool.query('UPDATE users SET total_leads = total_leads + 1 WHERE id=$1', [user.id]);
  } catch(e) { console.error('SMS error:', e.message); }
  res.status(200).send('OK');
});

// ── INCOMING SMS (Twilio-validated) ──
app.post('/api/twilio/sms', validateTwilio, async (req, res) => {
  const { From, To, Body } = req.body;

  const leadRes = await pool.query(`
    SELECT l.*, u.* FROM leads l
    JOIN users u ON l.user_id = u.id
    WHERE l.caller_phone=$1 AND l.status='waiting' AND u.twilio_number=$2
    ORDER BY l.created_at DESC LIMIT 1
  `, [From, To]);

  const row = leadRes.rows[0];
  let reply = "Thanks! We got your message and will call you back shortly.";

  if (row && isActive(row)) {
    const urgent = /urgent|emergency|asap|right now|leaking|flooding|no heat|no ac|burst|broken|fire|smoke|gas/i.test(Body);
    const addrMatch = Body.match(/\d+\s+[\w\s]+(st|ave|rd|blvd|dr|ln|way|ct|pl|street|avenue|road|drive|lane)/i);
    const conversation = [...(row.conversation||[]), { from:'customer', text:Body.slice(0,500), time:new Date().toISOString() }];

    await pool.query(`
      UPDATE leads SET status='captured', captured_at=NOW(), urgent=$1,
        service=COALESCE(service,$2), address=COALESCE(address,$3), conversation=$4
      WHERE id=$5
    `, [urgent||row.urgent, Body.slice(0,500), addrMatch?addrMatch[0]:row.address, JSON.stringify(conversation), row.id]);

    await notifyContractor(row, { ...row, urgent: urgent||row.urgent, service: row.service||Body, address: addrMatch?addrMatch[0]:row.address });
    reply = urgent ? `Got it — urgent. ${row.business_name} is being notified now.` : `Thanks! ${row.business_name} will call you back soon.`;
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0"?><Response><Message>${reply}</Message></Response>`);
});

// ── DASHBOARD API (authenticated) ──
app.get('/api/leads', requireAuth, async (req, res) => {
  const { userId } = req.query;
  const { rows } = await pool.query(
    'SELECT * FROM leads WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500', [userId]);
  res.json(rows);
});

app.get('/api/user/:userId', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const u = rows[0];
  // Never return auth_token or stripe internals in user response
  const { auth_token, stripe_customer_id, ...safe } = u;
  safe.active = isActive(u);
  res.json(safe);
});

app.patch('/api/user/:userId', requireAuth, async (req, res) => {
  const { customMessage, afterHoursMessage, businessHours, timezone, teamPhones } = req.body;
  await pool.query(`
    UPDATE users SET
      custom_message = COALESCE($1, custom_message),
      after_hours_message = COALESCE($2, after_hours_message),
      business_hours = COALESCE($3, business_hours),
      timezone = COALESCE($4, timezone),
      team_phones = COALESCE($5, team_phones)
    WHERE id=$6
  `, [customMessage||null, afterHoursMessage||null,
      businessHours?JSON.stringify(businessHours):null,
      timezone||null,
      teamPhones?JSON.stringify(teamPhones):null,
      req.params.userId]);
  res.json({ success: true });
});

// ── ADMIN: USER LIST (for you to see all users) ──
// Protected by a separate admin token from env var
app.get('/api/admin/users', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  const { rows } = await pool.query(`
    SELECT id, name, email, business_name, business_phone, twilio_number, trade,
           created_at, trial_ends_at, plan, paid, paid_through, stripe_customer_id
    FROM users ORDER BY created_at DESC
  `);
  res.json(rows);
});

// ── EMAIL HELPERS ──
async function notifyContractor(user, lead) {
  const flag = lead.urgent ? '🚨 URGENT — ' : '';
  const sms = `${flag}New lead!\nFrom: ${lead.caller_phone}\nService: ${lead.service||'See reply'}\nAddress: ${lead.address||'Ask when you call'}${lead.after_hours?' \n⏰ After hours':''}`;
  // Send to primary number
  try { await twilioClient.messages.create({ body: sms, from: user.twilio_number, to: user.business_phone }); }
  catch(e) { console.error('Contractor SMS:', e.message); }
  // Team plan: also send to additional team members
  if (user.plan === 'team' && Array.isArray(user.team_phones) && user.team_phones.length > 0) {
    for (const phone of user.team_phones) {
      try { await twilioClient.messages.create({ body: sms, from: user.twilio_number, to: phone }); }
      catch(e) { console.error('Team SMS error:', e.message); }
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
        <p><b>Service:</b> ${lead.service||'Not specified'}</p>
        <p><b>Address:</b> ${lead.address||'Ask when you call'}</p>
        <p><b>Urgent:</b> ${lead.urgent?'Yes 🚨':'No'}</p>
        ${lead.after_hours?'<p><b>⏰ After hours lead</b></p>':''}
        <a href="tel:${lead.caller_phone}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">📞 Call back now</a>
      </div>`,
    });
  } catch(e) { console.error('Email:', e.message); }
}
async function sendWelcomeEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  const num = user.twilioNumber;
  const digits = num.replace('+','').replace(/\D/g,'');
  const carrier = (user.carrier || 'other').toLowerCase();

  // Carrier-specific forwarding codes and instructions
  const carrierInstructions = {
    tmobile: {
      name: 'T-Mobile',
      dialCode: `**61*${digits}#`,
      note: 'T-Mobile uses a slightly different format.',
      extra: '<p style="font-size:13px;color:#888;margin-top:8px">T-Mobile tip: If this doesn\'t work, call <b>611</b> from your phone and say "Set up call forwarding when unanswered to ' + num + '". Takes 2 minutes.</p>'
    },
    att: {
      name: 'AT&T',
      dialCode: `*61*${digits}**18#`,
      note: null,
      extra: ''
    },
    verizon: {
      name: 'Verizon',
      dialCode: `*71${digits}`,
      note: null,
      extra: ''
    },
    other: {
      name: 'your carrier',
      dialCode: `*61*${digits}**18#`,
      note: null,
      extra: '<p style="font-size:13px;color:#888;margin-top:8px">If this code doesn\'t work for your carrier, text us at hello@calllocally.com and we\'ll send you the right one.</p>'
    }
  };

  const ci = carrierInstructions[carrier] || carrierInstructions.other;
  const dialCode = ci.dialCode;

  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: "You're live on CallLocally — one step left",
      html: `<div style="font-family:sans-serif;max-width:520px;color:#1a1a1a">
        <h2 style="color:#FF5C1A">Welcome, ${user.name}! 🎉</h2>
        <p style="font-size:16px">Your CallLocally number is ready:</p>
        <p style="font-size:36px;font-weight:700;color:#FF5C1A;letter-spacing:2px;margin:8px 0">${num}</p>
        <p style="color:#555;font-size:14px">Callers can text or leave a voicemail at this number. Both get delivered to you instantly.</p>

        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">

        <h3 style="margin-bottom:8px">Last step — forward your unanswered calls</h3>
        <p style="color:#555;margin-bottom:20px;font-size:14px">Dial the code below from your ${ci.name} phone and press <b>Call</b>. Your phone still rings normally — if you don't pick up, the caller can leave a voicemail <i>or</i> text back. Either way, you get notified instantly.</p>

        <div style="background:#fff8f5;border:2px solid #FF5C1A;border-radius:12px;padding:24px;text-align:center;margin-bottom:16px">
          <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#FF5C1A;margin-bottom:10px">Dial this on your ${ci.name} phone</p>
          <p style="font-size:32px;font-weight:700;font-family:monospace;color:#1a1a1a;letter-spacing:3px;margin:0">${dialCode}</p>
          <p style="font-size:13px;color:#888;margin-top:10px">Then press <b>Call</b>. Done.</p>
          ${ci.extra}
        </div>

        <div style="background:#f9f9f9;border-radius:8px;padding:14px;margin-bottom:20px">
          <p style="font-size:13px;color:#555;margin:0">
            <b>How it works after setup:</b><br>
            1. Customer calls your real number → rings you for 18 seconds<br>
            2. If no answer → they hear a voicemail greeting<br>
            3. They can leave a voicemail <b>or</b> reply via text<br>
            4. You get the voicemail recording + text transcript sent to your phone immediately<br><br>
            <b>To turn off forwarding later:</b> Dial <code>##61#</code> and press Call.
          </p>
        </div>

        <hr style="margin:24px 0;border:none;border-top:1px solid #eee">
        <p style="margin-bottom:4px"><b>Your dashboard:</b> <a href="https://calllocally.com/dashboard" style="color:#FF5C1A">calllocally.com/dashboard</a></p>
        <p style="font-size:13px;color:#999">Questions? Reply to this email or reach us at hello@calllocally.com</p>
      </div>`,
    });
  } catch(e) { console.error('Welcome email:', e.message); }
}

async function sendUpgradeEmail(user, plan) {
  if (!process.env.SENDGRID_API_KEY) return;
  const planName = PLANS[plan]?.name||plan;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: `You're on CallLocally ${planName} ✅`,
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2 style="color:#FF5C1A">You're on ${planName}!</h2>
        <p>Hey ${user.name}, your ${planName} plan is active. Your number <b>${user.twilio_number}</b> is capturing leads.</p>
      </div>`,
    });
  } catch(e) { console.error('Upgrade email:', e.message); }
}
async function sendCancellationEmail(user, paidThrough) {
  if (!process.env.SENDGRID_API_KEY) return;
  const endDate = new Date(paidThrough).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: 'Your CallLocally subscription has been cancelled',
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2>Subscription cancelled</h2>
        <p>Hey ${user.name}, your subscription is cancelled. Service continues until <b>${endDate}</b>.</p>
        <p><a href="https://calllocally.com/dashboard">Reactivate anytime →</a></p>
      </div>`,
    });
  } catch(e) { console.error('Cancel email:', e.message); }
}
async function sendPaymentFailedEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: '⚠️ Payment failed — update your card',
      html: `<div style="font-family:sans-serif;max-width:480px">
        <h2>Payment failed</h2>
        <p>Hey ${user.name}, please update your payment method to keep your number active.</p>
        <a href="https://calllocally.com/dashboard" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">Update payment →</a>
      </div>`,
    });
  } catch(e) { console.error('Payment failed email:', e.message); }
}
async function sendTrialEmail(user, daysLeft) {
  if (!process.env.SENDGRID_API_KEY) return;
  const link = `https://calllocally.com/dashboard?userId=${user.id}`;
  const configs = {
    7: { subject:'⏰ 7 days left on your CallLocally trial', body:`<p>Hey ${user.name}, 7 days left. Solo is $49/mo — <a href="${link}">upgrade now</a>.</p>` },
    1: { subject:'⚠️ Your trial ends tomorrow', body:`<p>Hey ${user.name}, trial ends tomorrow. <a href="${link}">Upgrade now →</a></p>` },
    0: { subject:'Your CallLocally trial has ended', body:`<p>Hey ${user.name}, trial ended. <a href="${link}">Reactivate →</a></p>` },
  };
  if (!configs[daysLeft]) return;
  try {
    await sgMail.send({ to: user.email, from: 'hello@calllocally.com', subject: configs[daysLeft].subject,
      html: `<div style="font-family:sans-serif;max-width:480px">${configs[daysLeft].body}</div>` });
  } catch(e) { console.error('Trial email:', e.message); }
}

// ── TRIAL CHECK ──
async function checkTrials() {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE paid=FALSE');
    for (const user of rows) {
      if (!user.trial_ends_at) continue;
      const daysLeftRaw = Math.ceil((new Date(user.trial_ends_at) - Date.now()) / 86400000);
      const daysLeft = daysLeftRaw < 0 ? 0 : daysLeftRaw;
      if ([7,1,0].includes(daysLeft) && user.last_trial_notification !== daysLeft) {
        await sendTrialEmail(user, daysLeft);
        await pool.query('UPDATE users SET last_trial_notification=$1 WHERE id=$2', [daysLeft, user.id]);
      }
    }
  } catch(e) { console.error('Trial check error:', e.message); }
}
setInterval(checkTrials, 60*60*1000);
setTimeout(checkTrials, 8000);


// ── ANALYTICS: Admin overview of all users + funnel ──
app.get('/api/admin/analytics', async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });

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
        COUNT(*) FILTER (WHERE trade = 'pool') as pool,
        COUNT(*) FILTER (WHERE trade = 'general') as other_trade,
        SUM(total_leads) as total_leads_all_time,
        SUM(total_urgent) as total_urgent_all_time
      FROM users
    `),
    pool.query(`
      SELECT
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE status = 'captured') as captured,
        COUNT(*) FILTER (WHERE status = 'waiting') as waiting,
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
        handyman: parseInt(users.handyman), painting: parseInt(users.painting), pool: parseInt(users.pool),
        other: parseInt(users.other_trade),
      },
    },
    leads: {
      total: parseInt(leads.total_leads),
      captured: parseInt(leads.captured),
      waiting: parseInt(leads.waiting),
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
});

// ── STATIC FILES ──
app.get('/dashboard', (req, res) => {
  const p = path.join(__dirname, 'public', 'dashboard.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(404).send('Not found');
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.send('CallLocally is running.');
});

// ── START ──
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`CallLocally running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  // Start anyway — DB may not be ready yet on first deploy
  app.listen(PORT, () => console.log(`CallLocally running (no DB) on port ${PORT}`));
});