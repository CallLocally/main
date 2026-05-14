/**
 * CallLocally — main server
 * --------------------------------------------------------------
 * Architecture (May 2026 refactor):
 *   - Per-contractor 10DLC number under ONE A2P Sole Prop Brand + Campaign
 *   - Inbound SMS/voice webhook routing by `To` field
 *   - Card-at-signup via Stripe Elements; 14-day trial starts immediately
 *   - subscription_status synced from Stripe (source of truth) with 3-day grace
 *   - Each provisioned number is auto-added to the shared Messaging Service
 *   - Double opt-in state machine on inbound SMS (consent_pending → granted → details → captured)
 *   - reclaimNumbers cron releases numbers from churned accounts after grace
 *
 * IMPORTANT: This file does NOT use Toll-Free Verification or admin-fallback senders.
 * All outbound SMS goes through the Messaging Service (Twilio handles A2P routing).
 */

'use strict';

// ============================================================
// IMPORTS & CLIENTS
// ============================================================
const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const crypto       = require('crypto');
const path         = require('path');
const { Pool }     = require('pg');
const twilio       = require('twilio');
const sgMail       = require('@sendgrid/mail');
const Stripe       = require('stripe');

// ============================================================
// ENV
// ============================================================
const {
  DATABASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_PRICE_STANDARD,
  STRIPE_WEBHOOK_SECRET,
  SENDGRID_API_KEY,
  EMAIL_FROM = 'CallLocally <hello@calllocally.com>',
  ADMIN_EMAIL = 'admin@calllocally.com',
  BASE_URL = 'https://calllocally.com',
  NODE_ENV = 'production',
  PORT = 3000,
} = process.env;

const REQUIRED_ENV = [
  'DATABASE_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID', 'STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_PRICE_STANDARD', 'STRIPE_WEBHOOK_SECRET', 'SENDGRID_API_KEY',
];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[boot] FATAL: missing required env var ${k}`);
    process.exit(1);
  }
}

const pool          = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const stripe        = Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
sgMail.setApiKey(SENDGRID_API_KEY);

const log = {
  info:  (...a) => console.log('[info]', ...a),
  warn:  (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

// ============================================================
// EXPRESS APP & MIDDLEWARE
// ============================================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));

// Stripe webhook MUST get raw body — register before express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

const signupLimiter        = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true });
const twilioWebhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 240 });
const apiLimiter           = rateLimit({ windowMs: 60 * 1000, max: 120 });

app.use('/api/signup',        signupLimiter);
app.use('/api/request-login', signupLimiter);
app.use('/api',               apiLimiter);

// Static files served last (below routes)

// ============================================================
// DATABASE INIT
// ============================================================
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                            TEXT PRIMARY KEY,
      auth_token                    TEXT UNIQUE NOT NULL,
      name                          TEXT NOT NULL,
      email                         TEXT UNIQUE NOT NULL,
      business_name                 TEXT NOT NULL,
      business_phone                TEXT NOT NULL,
      trade                         TEXT,
      twilio_number                 TEXT UNIQUE,
      twilio_number_sid             TEXT,
      custom_message                TEXT,
      timezone                      TEXT,
      created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      trial_ends_at                 TIMESTAMPTZ,
      plan                          TEXT NOT NULL DEFAULT 'standard',
      stripe_customer_id            TEXT,
      stripe_subscription_id        TEXT,
      subscription_status           TEXT,
      subscription_status_updated_at TIMESTAMPTZ,
      last_trial_notification       INT,
      total_leads                   INT NOT NULL DEFAULT 0,
      carrier                       TEXT,
      reclaimed_at                  TIMESTAMPTZ,
      sms_consent                   BOOLEAN NOT NULL DEFAULT FALSE,
      sms_consent_at                TIMESTAMPTZ
    );
  `);

  // Defensive idempotent migrations — new columns added since the TFV era.
  // ALTER TABLE ADD COLUMN IF NOT EXISTS is Postgres 9.6+, safe to run on every boot.
  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS twilio_number_sid TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status_updated_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reclaimed_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ`,
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) { log.warn('migration skipped', e.message); }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      caller_phone        TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'consent_pending',
      service             TEXT,
      conversation        JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consent_granted_at  TIMESTAMPTZ,
      captured_at         TIMESTAMPTZ,
      opted_out_at        TIMESTAMPTZ,
      contractor_notified BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_stripe_events (
      event_id     TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_tokens (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ
    );
  `);

  // Indexes
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_users_email           ON users (email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_auth_token      ON users (auth_token)`,
    `CREATE INDEX IF NOT EXISTS idx_users_twilio_number   ON users (twilio_number)`,
    `CREATE INDEX IF NOT EXISTS idx_users_stripe_sub      ON users (stripe_subscription_id)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_user_created    ON leads (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_leads_caller_status   ON leads (user_id, caller_phone, status)`,
    `CREATE INDEX IF NOT EXISTS idx_login_tokens_expires  ON login_tokens (expires_at)`,
  ];
  for (const sql of indexes) {
    try { await pool.query(sql); } catch (e) { log.warn('index skipped', e.message); }
  }

  log.info('db ready');
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function newId(prefix = '') {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function newAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

function normalizePhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits;
}

function extractAreaCode(phoneE164) {
  // +1XXXYYYZZZZ → XXX
  const m = String(phoneE164 || '').match(/^\+1(\d{3})/);
  return m ? m[1] : null;
}

function looksLikeYes(body) {
  return /^\s*(y|yes|yeah|yep|sure|ok|okay|confirm)\b/i.test(body || '');
}

function looksLikeStop(body) {
  // Twilio handles STOP at the carrier level on Messaging Service, but we double-check
  return /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt out|opt-out)\b/i.test(body || '');
}

/**
 * Send an SMS via the shared Messaging Service.
 * Twilio routes through the appropriate 10DLC sender based on the campaign.
 * Used for ALL outbound system messages.
 */
async function smsCreate(to, body) {
  try {
    return await twilioClient.messages.create({
      to: normalizePhone(to),
      body,
      messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
    });
  } catch (e) {
    log.error('smsCreate failed', { to, code: e.code, msg: e.message });
    throw e;
  }
}

/**
 * Send an SMS from a SPECIFIC contractor number (used for contractor → caller threading
 * once a lead is captured, so the caller sees a consistent local number).
 */
async function smsCreateFromNumber(from, to, body) {
  try {
    return await twilioClient.messages.create({
      from: normalizePhone(from),
      to: normalizePhone(to),
      body,
    });
  } catch (e) {
    log.error('smsCreateFromNumber failed', { from, to, code: e.code, msg: e.message });
    throw e;
  }
}

async function sendEmail({ to, subject, html, text }) {
  try {
    await sgMail.send({ to, from: EMAIL_FROM, subject, html, text: text || stripHtml(html) });
  } catch (e) {
    log.error('sendEmail failed', { to, subject, msg: e.message });
  }
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, ''); }

/**
 * Provision a 10DLC number — buys an available local number in the contractor's
 * own area code (or a fallback), wires it to the SMS + Voice webhooks, and
 * registers it under the shared Messaging Service so A2P routing kicks in.
 *
 * Returns { phoneNumber, phoneNumberSid }.
 */
async function provision10DLC(preferredAreaCode) {
  const tryAreaCodes = [preferredAreaCode, '714', '949', '310', '213', '562'].filter(Boolean);
  let available = [];
  for (const areaCode of tryAreaCodes) {
    available = await twilioClient.availablePhoneNumbers('US').local.list({
      areaCode,
      smsEnabled: true,
      voiceEnabled: true,
      excludeAllAddressRequired: true,
      limit: 1,
    });
    if (available.length) break;
  }
  if (!available.length) {
    // Last resort: any US local number
    available = await twilioClient.availablePhoneNumbers('US').local.list({
      smsEnabled: true, voiceEnabled: true, limit: 1,
    });
  }
  if (!available.length) throw new Error('No 10DLC numbers available from Twilio inventory');

  const num = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    smsUrl:         `${BASE_URL}/api/twilio/sms`,
    smsMethod:      'POST',
    voiceUrl:       `${BASE_URL}/api/forward`,
    voiceMethod:    'POST',
    statusCallback: `${BASE_URL}/api/call-status`,
  });

  await addToMessagingService(num.sid);

  return { phoneNumber: num.phoneNumber, phoneNumberSid: num.sid };
}

async function addToMessagingService(phoneNumberSid) {
  return twilioClient.messaging.v1
    .services(TWILIO_MESSAGING_SERVICE_SID)
    .phoneNumbers.create({ phoneNumberSid });
}

/**
 * Cron: release Twilio numbers from accounts that have been canceled / unpaid
 * beyond the 3-day grace window. Returns count of numbers reclaimed.
 */
async function reclaimNumbers() {
  const { rows } = await pool.query(`
    SELECT id, twilio_number_sid, twilio_number, email
      FROM users
     WHERE subscription_status IN ('canceled','incomplete_expired','unpaid')
       AND subscription_status_updated_at < NOW() - INTERVAL '3 days'
       AND twilio_number_sid IS NOT NULL
       AND reclaimed_at IS NULL
  `);
  let released = 0;
  for (const u of rows) {
    try {
      await twilioClient.incomingPhoneNumbers(u.twilio_number_sid).remove();
      await pool.query(
        `UPDATE users SET twilio_number = NULL, twilio_number_sid = NULL, reclaimed_at = NOW() WHERE id = $1`,
        [u.id]
      );
      released++;
      log.info('reclaimed number', { user: u.id, number: u.twilio_number });
    } catch (e) {
      log.error('reclaim failed', u.id, e.message);
    }
  }
  return released;
}

/**
 * Service eligibility check. A user is "active" if Stripe says so, OR if they're
 * within the 3-day grace period after a payment failure.
 */
function isServiceActive(user) {
  if (!user) return false;
  if (user.subscription_status === 'trialing') return true;
  if (user.subscription_status === 'active')   return true;
  if (user.subscription_status === 'past_due' || user.subscription_status === 'incomplete') {
    const updatedAt = user.subscription_status_updated_at
      ? new Date(user.subscription_status_updated_at) : new Date(0);
    return (Date.now() - updatedAt.getTime()) < (3 * 24 * 60 * 60 * 1000);
  }
  return false;
}

/**
 * Carrier conditional-forwarding (CFNA) instructions. Returned to the contractor
 * after signup so they can set up forwarding on their existing phone in 5 min.
 * Patterns: dial code → contractor's existing phone forwards unanswered calls to
 * their dedicated CallLocally 10DLC number.
 */
function getForwardingInstructions(carrier, twilioNumber) {
  const num = String(twilioNumber || '').replace(/\D/g, ''); // 10–11 digit string for dialing
  const map = {
    verizon:    { code: `*71${num}`,          name: 'Verizon',     note: 'Forwards on no-answer and busy. To disable: *73.' },
    att:        { code: `*61*${num}#`,        name: 'AT&T',        note: 'Conditional forward (no-answer). To disable: ##61#.' },
    tmobile:    { code: `**61*${num}*11*30#`, name: 'T-Mobile',    note: 'Forwards after ~30 sec ring. To disable: ##61#.' },
    sprint:     { code: `**61*${num}*11*30#`, name: 'Sprint',      note: 'Same as T-Mobile. To disable: ##61#.' },
    uscellular: { code: `*71${num}`,          name: 'US Cellular', note: 'Forwards on no-answer and busy. To disable: *73.' },
    other:      { code: `*72${num}`,          name: 'Generic',     note: 'Try *72 (forward all) if no-answer code unknown. To disable: *73.' },
  };
  return map[String(carrier || '').toLowerCase()] || map.other;
}

function defaultCustomMessage(businessName) {
  return `Hi! ${businessName} missed your call but asked us to follow up. Reply YES to get connected. Std msg rates may apply. Reply STOP to opt out.`;
}

function detailsPromptMessage(businessName) {
  return `Thanks! What do you need help with? We'll get ${businessName} on it.`;
}

function callerConfirmMessage(businessName) {
  return `Got it! ${businessName} has been notified and will be in touch shortly.`;
}

function contractorLeadSms(callerPhone, serviceNeed, reachedOutAt) {
  const when = reachedOutAt
    ? new Date(reachedOutAt).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : 'just now';
  return [
    '📬 New CallLocally lead',
    `From: ${callerPhone}`,
    `Called: ${when}`,
    `They need: "${serviceNeed}"`,
    '',
    'Reply to this text to reach them directly.',
  ].join('\n');
}

// ============================================================
// AUTH MIDDLEWARE (for dashboard / settings endpoints)
// ============================================================
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing auth' });
  const { rows } = await pool.query(`SELECT * FROM users WHERE auth_token = $1`, [token]);
  if (!rows.length) return res.status(401).json({ error: 'invalid auth' });
  req.user = rows[0];
  next();
}

// Validate Twilio webhook signatures (returns middleware)
function validateTwilio(req, res, next) {
  if (NODE_ENV !== 'production') return next(); // skip in dev
  const sig = req.headers['x-twilio-signature'];
  const url = `${BASE_URL}${req.originalUrl}`;
  const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, sig, url, req.body || {});
  if (!valid) {
    log.warn('invalid twilio signature', req.originalUrl);
    return res.status(403).send('invalid signature');
  }
  next();
}

// ============================================================
// STRIPE WEBHOOK
// ============================================================
async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    log.error('stripe webhook signature failed', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  // Idempotency: skip if we've seen this event_id
  try {
    await pool.query(
      `INSERT INTO processed_stripe_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [event.id]
    );
  } catch (e) { log.error('idempotency insert failed', e.message); }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await pool.query(
          `UPDATE users
              SET subscription_status = $1,
                  subscription_status_updated_at = NOW(),
                  stripe_subscription_id = $2
            WHERE stripe_customer_id = $3`,
          [sub.status, sub.id, sub.customer]
        );
        log.info('stripe sub sync', { status: sub.status, customer: sub.customer });
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        await pool.query(
          `UPDATE users
              SET subscription_status = 'past_due',
                  subscription_status_updated_at = NOW()
            WHERE stripe_customer_id = $1`,
          [inv.customer]
        );
        // Notify contractor by email so they can update their card
        const { rows } = await pool.query(`SELECT email, name FROM users WHERE stripe_customer_id = $1`, [inv.customer]);
        if (rows.length) {
          await sendEmail({
            to: rows[0].email,
            subject: 'Payment issue — your CallLocally service',
            html: `<p>Hi ${rows[0].name},</p><p>We weren't able to process your last CallLocally payment. Your service will continue for 3 days while you update your card. <a href="${BASE_URL}/dashboard">Update payment method</a>.</p>`,
          });
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        await pool.query(
          `UPDATE users
              SET subscription_status = 'active',
                  subscription_status_updated_at = NOW()
            WHERE stripe_customer_id = $1
              AND subscription_status IN ('past_due','incomplete')`,
          [inv.customer]
        );
        break;
      }
      default:
        // Ignore other events
        break;
    }
  } catch (e) {
    log.error('stripe webhook handler error', event.type, e.message);
    // 200 anyway — Stripe retries cost us nothing, and we've recorded the event_id
  }
  res.json({ received: true });
}

// ============================================================
// SIGNUP — creates Stripe customer + subscription, provisions 10DLC,
//           sends welcome email with forwarding code.
// ============================================================
app.post('/api/signup', async (req, res) => {
  try {
    const {
      name, email, businessName, businessPhone, trade,
      carrier, timezone, smsConsent, paymentMethodId,
    } = req.body || {};

    // ---- Validation ----
    if (!name || !email || !businessName || !businessPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (smsConsent !== true) {
      return res.status(400).json({ error: 'SMS consent required' });
    }
    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Payment method required' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    const normalizedBusinessPhone = normalizePhone(businessPhone);
    if (!normalizedBusinessPhone || normalizedBusinessPhone.length < 10) {
      return res.status(400).json({ error: 'Invalid phone' });
    }

    // ---- Uniqueness ----
    const dupe = await pool.query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase()]);
    if (dupe.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // ---- Stripe: create customer (stores the card; does NOT start the trial clock) ----
    const customer = await stripe.customers.create({
      email: email.toLowerCase(),
      name,
      phone: normalizedBusinessPhone,
      metadata: { business_name: businessName, trade: trade || '' },
      payment_method: paymentMethodId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // ---- Twilio: provision the 10DLC number FIRST ----
    // Per Decisions Log (2026-05-13): the 14-day trial clock must not start until the
    // contractor's number is confirmed provisioned and operational. So provisioning
    // happens before the Stripe subscription is created below.
    const areaCode = extractAreaCode(normalizedBusinessPhone);
    const { phoneNumber, phoneNumberSid } = await provision10DLC(areaCode);

    // ---- Stripe: create the subscription AFTER provisioning (this starts the trial) ----
    // If subscription creation fails here, release the number we just bought so it is
    // not left orphaned on the account.
    let subscription;
    try {
      subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: STRIPE_PRICE_STANDARD }],
        trial_period_days: 14,
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
      });
    } catch (subErr) {
      try {
        await twilioClient.incomingPhoneNumbers(phoneNumberSid).remove();
        log.warn('released orphaned number after Stripe subscription failure', phoneNumber);
      } catch (relErr) {
        log.error('failed to release orphaned number', phoneNumberSid, relErr.message);
      }
      throw subErr;
    }

    // ---- DB: insert user ----
    const userId = newId('usr_');
    const authToken = newAuthToken();
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO users
        (id, auth_token, name, email, business_name, business_phone, trade,
         twilio_number, twilio_number_sid, custom_message,
         timezone, trial_ends_at, plan, stripe_customer_id, stripe_subscription_id,
         subscription_status, subscription_status_updated_at, carrier,
         sms_consent, sms_consent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'standard',$13,$14,$15,NOW(),$16,TRUE,NOW())`,
      [
        userId, authToken, name, email.toLowerCase(), businessName, normalizedBusinessPhone, trade || null,
        phoneNumber, phoneNumberSid,
        defaultCustomMessage(businessName),
        timezone || 'America/Los_Angeles', trialEndsAt,
        customer.id, subscription.id, subscription.status,
        (carrier || '').toLowerCase() || null,
      ]
    );

    // ---- Forwarding code + welcome email ----
    const fwd = getForwardingInstructions(carrier, normalizedBusinessPhone);
    await sendEmail({
      to: email,
      subject: 'Welcome to CallLocally — your number is live',
      html: `
        <h2>You're all set, ${name}.</h2>
        <p>Your dedicated CallLocally number: <strong>${phoneNumber}</strong></p>
        <p>To finish setup, dial this code from your business phone (${fwd.name}):</p>
        <p style="font-size:20px;font-family:monospace"><strong>${fwd.code}</strong></p>
        <p>${fwd.note}</p>
        <p>Your 14-day free trial is active. We'll email you 3 days before it ends.</p>
        <p><a href="${BASE_URL}/dashboard?token=${authToken}">Open your dashboard →</a></p>
      `,
    });

    // ---- Setup SMS to the contractor (their audience lives on text, not email) ----
    try {
      await smsCreate(
        normalizedBusinessPhone,
        `Welcome to CallLocally, ${name}! Your number is live: ${phoneNumber}. ` +
        `To finish setup, dial ${fwd.code} from this phone (${fwd.name}). ${fwd.note} ` +
        `Dashboard: ${BASE_URL}/dashboard?token=${authToken}`
      );
    } catch (e) {
      log.error('setup SMS failed', e.message);
    }

    res.json({
      ok: true,
      authToken,
      twilioNumber: phoneNumber,
      trialEndsAt,
      forwardingCode: fwd.code,
      forwardingNote: fwd.note,
      carrier: fwd.name,
      subscriptionStatus: subscription.status,
    });
  } catch (e) {
    log.error('signup failed', e.message, e.code || '');
    // Friendly errors for known Stripe failures
    if (e.type === 'StripeCardError') {
      return res.status(402).json({ error: e.message || 'Card declined' });
    }
    res.status(500).json({ error: 'Signup failed. Please try again or contact support.' });
  }
});

// ============================================================
// LOGIN — magic link (email)
// ============================================================
app.post('/api/request-login', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { rows } = await pool.query(`SELECT id, name FROM users WHERE email = $1`, [email.toLowerCase()]);
    // Always return ok — don't leak which emails are registered
    if (!rows.length) return res.json({ ok: true });

    const token = newAuthToken();
    const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 min
    await pool.query(
      `INSERT INTO login_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, rows[0].id, expires]
    );
    await sendEmail({
      to: email,
      subject: 'Your CallLocally login link',
      html: `<p>Hi ${rows[0].name},</p><p><a href="${BASE_URL}/dashboard?login=${token}">Click here to log in</a>. This link expires in 30 minutes.</p>`,
    });
    res.json({ ok: true });
  } catch (e) {
    log.error('request-login failed', e.message);
    res.status(500).json({ error: 'Login request failed' });
  }
});

app.post('/api/consume-login', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const { rows } = await pool.query(
      `UPDATE login_tokens SET used_at = NOW()
        WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING user_id`,
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid or expired token' });
    const userQ = await pool.query(`SELECT auth_token FROM users WHERE id = $1`, [rows[0].user_id]);
    res.json({ ok: true, authToken: userQ.rows[0].auth_token });
  } catch (e) {
    log.error('consume-login failed', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================================
// TWILIO VOICE WEBHOOK CHAIN — inbound forwarded call
// ============================================================
// /api/forward → the carrier already determined this call was unanswered, so we go
// /api/dial-complete → if no answer, kicks off the SMS opt-in flow to the caller
// /api/voicemail → optional voicemail recording
// /api/call-status → analytics callbacks
//
// In practice for solo operators, the carrier itself forwards to /api/forward
// because the contractor's phone didn't answer in the first place. We then
// respond with TwiML that fires the consent SMS to the caller and hangs up.

app.post('/api/forward', twilioWebhookLimiter, validateTwilio, async (req, res) => {
  try {
    const toNumber = normalizePhone(req.body.To);
    const fromNumber = normalizePhone(req.body.From);
    const callSid = req.body.CallSid;

    const { rows } = await pool.query(`SELECT * FROM users WHERE twilio_number = $1`, [toNumber]);
    const user = rows[0];

    // Carrier already determined this was unanswered → forward to SMS opt-in.
    // We don't try to ring the contractor again (would defeat the whole purpose).
    if (!user || !isServiceActive(user)) {
      // Service inactive or unknown number — quietly drop with brief message
      const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Sorry, this number is not currently in service. Goodbye.</Say></Response>`;
      return res.type('text/xml').send(twiml);
    }

    // Kick off async SMS opt-in to the caller, return TwiML to politely end the call.
    initiateConsentSms(user, fromNumber, callSid).catch(e => log.error('consent SMS init failed', e.message));

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="alice">Thanks for calling ${escapeXml(user.business_name)}. We just sent you a text — reply to it and we'll get back to you right away. Goodbye.</Say>
      </Response>`;
    res.type('text/xml').send(twiml);
  } catch (e) {
    log.error('forward webhook error', e.message);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});

app.post('/api/dial-complete', twilioWebhookLimiter, validateTwilio, async (req, res) => {
  // Reserved for advanced workflows (dial-then-fallback). Currently /api/forward
  // handles everything inline, but we keep the route registered so Twilio webhooks
  // don't 404 if a contractor's number has it configured from earlier.
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
});

app.post('/api/voicemail', twilioWebhookLimiter, validateTwilio, async (req, res) => {
  // Optional: caller hung up before SMS arrived → we could attach recording to lead.
  // For now, just acknowledge so Twilio doesn't retry.
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response/>`);
});

app.post('/api/call-status', twilioWebhookLimiter, validateTwilio, async (req, res) => {
  // Status callback — used for analytics, no response body needed
  log.info('call status', { sid: req.body.CallSid, status: req.body.CallStatus });
  res.sendStatus(204);
});

function escapeXml(s) {
  return String(s || '').replace(/[<>&'"]/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'
  }[c]));
}

/**
 * Begin the double opt-in conversation by sending the consent prompt.
 * Creates (or reuses) a lead row in `consent_pending` state.
 */
async function initiateConsentSms(user, callerPhone, callSid) {
  // Look for an existing recent open conversation with this caller (within last 24h)
  // so we don't double-text someone who's already in flight.
  const existing = await pool.query(
    `SELECT id, status FROM leads
      WHERE user_id = $1 AND caller_phone = $2
        AND status NOT IN ('captured','opted_out')
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [user.id, callerPhone]
  );

  let leadId;
  if (existing.rows.length) {
    leadId = existing.rows[0].id;
  } else {
    leadId = newId('lead_');
    await pool.query(
      `INSERT INTO leads (id, user_id, caller_phone, status, conversation)
       VALUES ($1, $2, $3, 'consent_pending', '[]'::jsonb)`,
      [leadId, user.id, callerPhone]
    );
  }

  const msg = user.custom_message || defaultCustomMessage(user.business_name);
  await smsCreate(callerPhone, msg);

  await pool.query(
    `UPDATE leads SET conversation = conversation || $1::jsonb WHERE id = $2`,
    [JSON.stringify([{ direction: 'outbound', body: msg, at: new Date().toISOString() }]), leadId]
  );
}

// ============================================================
// TWILIO SMS WEBHOOK — double opt-in state machine
// ============================================================
//
// State transitions:
//   consent_pending  --(caller YES)-->     consent_granted   (send details prompt)
//   consent_pending  --(caller STOP)-->    opted_out
//   consent_granted  --(caller msg)-->     captured           (capture lead, notify contractor)
//   captured         --(caller msg)-->     captured           (append to conversation)
//   captured         --(contractor msg)--> captured           (append + forward to caller)
//
app.post('/api/twilio/sms', twilioWebhookLimiter, validateTwilio, async (req, res) => {
  try {
    const toNumber = normalizePhone(req.body.To);       // the 10DLC number that received the SMS
    const fromNumber = normalizePhone(req.body.From);   // the caller / contractor
    const body = (req.body.Body || '').trim();

    // Route by `To` — find the contractor whose number this is
    const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE twilio_number = $1`, [toNumber]);
    const user = userRows[0];
    if (!user) {
      log.warn('inbound SMS to unknown number', toNumber);
      return res.type('text/xml').send('<Response/>');
    }

    // Service inactive? Drop silently.
    if (!isServiceActive(user)) {
      log.info('inbound SMS for inactive user', user.id);
      return res.type('text/xml').send('<Response/>');
    }

    // Determine if this is a CONTRACTOR replying (from their business_phone) vs a CALLER
    const businessPhoneNormalized = normalizePhone(user.business_phone);
    const isFromContractor = fromNumber === businessPhoneNormalized;

    if (isFromContractor) {
      // Contractor is replying to a lead — forward to the most recent active caller
      const { rows } = await pool.query(
        `SELECT id, caller_phone, conversation FROM leads
          WHERE user_id = $1 AND status = 'captured'
          ORDER BY captured_at DESC LIMIT 1`,
        [user.id]
      );
      if (rows.length) {
        const lead = rows[0];
        try {
          await smsCreateFromNumber(toNumber, lead.caller_phone, body);
          await pool.query(
            `UPDATE leads SET conversation = conversation || $1::jsonb WHERE id = $2`,
            [JSON.stringify([{ direction: 'contractor_to_caller', body, at: new Date().toISOString() }]), lead.id]
          );
        } catch (e) { log.error('contractor reply forward failed', e.message); }
      }
      return res.type('text/xml').send('<Response/>');
    }

    // ---- Caller side: state machine ----
    const { rows: leadRows } = await pool.query(
      `SELECT * FROM leads
        WHERE user_id = $1 AND caller_phone = $2
          AND status NOT IN ('opted_out')
        ORDER BY created_at DESC LIMIT 1`,
      [user.id, fromNumber]
    );
    let lead = leadRows[0];

    // No lead yet? Create one in consent_pending — but only if the message looks
    // like a YES (otherwise it's a cold inbound from someone we never texted, and
    // sending a consent prompt unsolicited would be a TCPA violation).
    if (!lead) {
      // Cold inbound — don't auto-message. Log and drop.
      log.info('cold inbound SMS, no lead exists', { user: user.id, from: fromNumber });
      return res.type('text/xml').send('<Response/>');
    }

    // Record the inbound message in the conversation log
    await pool.query(
      `UPDATE leads SET conversation = conversation || $1::jsonb WHERE id = $2`,
      [JSON.stringify([{ direction: 'inbound', body, at: new Date().toISOString() }]), lead.id]
    );

    // STOP handling (defensive — Twilio also handles this at the MS level)
    if (looksLikeStop(body)) {
      await pool.query(
        `UPDATE leads SET status = 'opted_out', opted_out_at = NOW() WHERE id = $1`,
        [lead.id]
      );
      return res.type('text/xml').send('<Response/>');
    }

    if (lead.status === 'consent_pending') {
      if (looksLikeYes(body)) {
        // YES → grant consent, ask for details
        const reply = detailsPromptMessage(user.business_name);
        await pool.query(
          `UPDATE leads
              SET status = 'consent_granted',
                  consent_granted_at = NOW(),
                  conversation = conversation || $1::jsonb
            WHERE id = $2`,
          [JSON.stringify([{ direction: 'outbound', body: reply, at: new Date().toISOString() }]), lead.id]
        );
        await smsCreate(fromNumber, reply);
      } else {
        // Anything that isn't YES while pending — don't badger. Just drop.
        // (User can text YES later and we'll pick it up.)
      }
      return res.type('text/xml').send('<Response/>');
    }

    if (lead.status === 'consent_granted') {
      // This is the details message — capture the lead
      const reply = callerConfirmMessage(user.business_name);
      await pool.query(
        `UPDATE leads
            SET status = 'captured',
                service = COALESCE(service, $1),
                captured_at = NOW(),
                conversation = conversation || $2::jsonb
          WHERE id = $3`,
        [
          body.slice(0, 500),
          JSON.stringify([{ direction: 'outbound', body: reply, at: new Date().toISOString() }]),
          lead.id,
        ]
      );

      // Increment counters
      await pool.query(`UPDATE users SET total_leads = total_leads + 1 WHERE id = $1`, [user.id]);

      // Notify caller
      await smsCreate(fromNumber, reply);

      // Notify contractor: SMS + email
      try {
        const contractorSms = contractorLeadSms(fromNumber, body.slice(0, 400), lead.created_at);
        await smsCreate(businessPhoneNormalized, contractorSms);
      } catch (e) { log.error('contractor sms notify failed', e.message); }

      try {
        const calledAt = new Date(lead.created_at).toLocaleString('en-US', {
          timeZone: user.timezone || 'America/Los_Angeles',
        });
        await sendEmail({
          to: user.email,
          subject: `📬 New lead from ${fromNumber}`,
          html: `
            <h3>New lead captured</h3>
            <p><strong>From:</strong> ${fromNumber}</p>
            <p><strong>Called:</strong> ${calledAt}</p>
            <p><strong>What they need:</strong></p>
            <blockquote style="border-left:3px solid #FF5C1A;padding-left:12px">${escapeXml(body)}</blockquote>
            <p><a href="${BASE_URL}/dashboard?token=${user.auth_token}">View the full conversation in your dashboard →</a></p>
          `,
        });
      } catch (e) { log.error('contractor email notify failed', e.message); }

      await pool.query(`UPDATE leads SET contractor_notified = TRUE WHERE id = $1`, [lead.id]);
      return res.type('text/xml').send('<Response/>');
    }

    if (lead.status === 'captured') {
      // Caller followed up after capture — just forward to contractor (no auto-reply)
      try {
        await smsCreate(businessPhoneNormalized, `↪ ${fromNumber}: ${body.slice(0, 400)}`);
      } catch (e) { log.error('caller followup forward failed', e.message); }
      return res.type('text/xml').send('<Response/>');
    }

    return res.type('text/xml').send('<Response/>');
  } catch (e) {
    log.error('sms webhook error', e.message);
    return res.type('text/xml').send('<Response/>');
  }
});

// ============================================================
// DASHBOARD API
// ============================================================
app.get('/api/me', requireAuth, async (req, res) => {
  const u = req.user;
  const fwd = getForwardingInstructions(u.carrier, u.business_phone);
  res.json({
    id: u.id,
    name: u.name,
    email: u.email,
    businessName: u.business_name,
    businessPhone: u.business_phone,
    trade: u.trade,
    twilioNumber: u.twilio_number,
    customMessage: u.custom_message,
    timezone: u.timezone,
    plan: u.plan,
    subscriptionStatus: u.subscription_status,
    trialEndsAt: u.trial_ends_at,
    totalLeads: u.total_leads,
    carrier: u.carrier,
    forwarding: { code: fwd.code, name: fwd.name, note: fwd.note },
    serviceActive: isServiceActive(u),
  });
});

app.get('/api/leads', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    `SELECT id, caller_phone, status, service,
            conversation, created_at, captured_at
       FROM leads
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [req.user.id, limit]
  );
  res.json({ leads: rows });
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const [{ rows: captured }, { rows: pending }, { rows: recent }] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM leads WHERE user_id = $1 AND status = 'captured'`, [userId]),
    pool.query(`SELECT COUNT(*) AS n FROM leads WHERE user_id = $1 AND status IN ('consent_pending','consent_granted')`, [userId]),
    pool.query(`SELECT id, caller_phone, status, service, created_at, captured_at
                  FROM leads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]),
  ]);
  res.json({
    capturedCount: parseInt(captured[0].n, 10),
    pendingCount:  parseInt(pending[0].n, 10),
    recent,
  });
});

app.post('/api/update-settings', requireAuth, async (req, res) => {
  const allowed = ['customMessage', 'timezone', 'carrier'];
  const updates = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if (!Object.keys(updates).length) return res.json({ ok: true, updated: 0 });

  const colMap = {
    customMessage: 'custom_message',
    timezone: 'timezone',
    carrier: 'carrier',
  };
  const setClauses = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    setClauses.push(`${colMap[k]} = $${i++}`);
    params.push(v);
  }
  params.push(req.user.id);
  await pool.query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = $${i}`, params);
  res.json({ ok: true, updated: Object.keys(updates).length });
});

// ============================================================
// BILLING PORTAL
// ============================================================
app.post('/api/billing-portal', requireAuth, async (req, res) => {
  try {
    if (!req.user.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: `${BASE_URL}/dashboard`,
    });
    res.json({ url: session.url });
  } catch (e) {
    log.error('billing portal failed', e.message);
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

// ============================================================
// STATIC + SPA FALLBACK
// ============================================================
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Public client config — the Stripe publishable key is safe to expose; it's
// designed to be used in browser code. The signup page fetches this on load.
app.get('/api/config', (_req, res) => {
  res.json({ stripePublishableKey: STRIPE_PUBLISHABLE_KEY });
});

app.get('/dashboard', (_req, res) => res.sendFile(path.join(publicDir, 'dashboard.html')));
app.get('/signup',    (_req, res) => res.sendFile(path.join(publicDir, 'signup.html')));
app.get('/login',     (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Catch-all for any other GET → index.html (landing)
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ============================================================
// CRON JOBS
// ============================================================

// Trial reminders — every hour, find users whose trial ends in {3, 1} days
// and email them if we haven't sent that reminder yet.
async function sendTrialReminders() {
  for (const daysOut of [3, 1]) {
    const { rows } = await pool.query(
      `SELECT id, name, email, trial_ends_at FROM users
        WHERE subscription_status = 'trialing'
          AND (last_trial_notification IS NULL OR last_trial_notification > $1)
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < NOW() + ($2 || ' days')::interval
          AND trial_ends_at > NOW()`,
      [daysOut, String(daysOut)]
    );
    for (const u of rows) {
      try {
        await sendEmail({
          to: u.email,
          subject: `Your CallLocally trial ends in ${daysOut} day${daysOut === 1 ? '' : 's'}`,
          html: `<p>Hi ${u.name},</p><p>Heads up — your 14-day free trial ends on ${new Date(u.trial_ends_at).toDateString()}. Your card will be charged $29 to keep your service running. <a href="${BASE_URL}/dashboard">Manage your subscription</a>.</p>`,
        });
        await pool.query(`UPDATE users SET last_trial_notification = $1 WHERE id = $2`, [daysOut, u.id]);
      } catch (e) { log.error('trial reminder failed', u.id, e.message); }
    }
  }
}

// Subscription reconciliation — daily safety net in case Stripe webhooks missed events.
async function reconcileSubscriptions() {
  const { rows } = await pool.query(
    `SELECT id, stripe_subscription_id FROM users WHERE stripe_subscription_id IS NOT NULL`
  );
  for (const u of rows) {
    try {
      const sub = await stripe.subscriptions.retrieve(u.stripe_subscription_id);
      await pool.query(
        `UPDATE users
            SET subscription_status = $1,
                subscription_status_updated_at = NOW()
          WHERE id = $2 AND subscription_status IS DISTINCT FROM $1`,
        [sub.status, u.id]
      );
    } catch (e) {
      if (e.code === 'resource_missing') {
        // Subscription deleted in Stripe — mark canceled locally
        await pool.query(
          `UPDATE users SET subscription_status = 'canceled', subscription_status_updated_at = NOW() WHERE id = $1`,
          [u.id]
        );
      } else { log.error('reconcile sub failed', u.id, e.message); }
    }
  }
}

function scheduleCrons() {
  setInterval(() => sendTrialReminders().catch(e => log.error('cron trial reminders', e.message)),
              60 * 60 * 1000); // hourly
  setInterval(() => reclaimNumbers().catch(e => log.error('cron reclaim numbers', e.message)),
              6 * 60 * 60 * 1000); // every 6h
  setInterval(() => reconcileSubscriptions().catch(e => log.error('cron reconcile subs', e.message)),
              24 * 60 * 60 * 1000); // daily
  log.info('crons scheduled (trial reminders hourly, reclaim 6h, reconcile daily)');
}

// ============================================================
// SERVER STARTUP
// ============================================================
async function start() {
  await initDb();
  scheduleCrons();
  app.listen(PORT, () => log.info(`CallLocally server listening on :${PORT}`));
}

start().catch(e => {
  log.error('startup failed', e);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => log.error('unhandledRejection', reason));
process.on('uncaughtException',  (err)    => log.error('uncaughtException', err));
