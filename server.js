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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      trial_ends_at TIMESTAMPTZ,
      plan TEXT,
      paid BOOLEAN DEFAULT FALSE,
      paid_through TIMESTAMPTZ,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      last_trial_notification INT
    );
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
  const { name, email, businessName, businessPhone, trade } = req.body;
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
      INSERT INTO users (id, auth_token, name, email, business_name, business_phone, trade, twilio_number, custom_message, after_hours_message, trial_ends_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      userId, authToken, name.slice(0,100), cleanEmail, businessName.slice(0,200),
      formattedPhone, trade||'general', purchased.phoneNumber,
      `Hi! This is ${businessName} — sorry we missed your call. What service do you need, and what's the address?`,
      `Hi! This is ${businessName} — we're currently closed. Leave your service need and address and we'll call first thing in the morning.`,
      trialEndsAt,
    ]);

    await sendWelcomeEmail({ name, email: cleanEmail, businessName, twilioNumber: purchased.phoneNumber, id: userId });
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
        [['active','trialing'].includes(sub.status), sub.metadata?.plan||null, sub.id]);
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

// ── CALL FORWARDING ──
app.get('/api/forward', async (req, res) => {
  const calledNum = req.query.To || req.body?.To;
  const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [calledNum]);
  const user = rows[0];
  res.set('Content-Type', 'text/xml');
  if (!user) return res.send('<?xml version="1.0"?><Response><Say>This number is not configured.</Say></Response>');
  res.send(`<?xml version="1.0"?><Response><Dial timeout="15" statusCallback="${RAILWAY_URL}/api/call-status" statusCallbackEvent="completed,no-answer,busy,failed" statusCallbackMethod="POST">${user.business_phone}</Dial></Response>`);
});

// ── CALL STATUS → SMS (Twilio-validated) ──
app.post('/api/call-status', validateTwilio, async (req, res) => {
  const { DialCallStatus, Caller, Called } = req.body;
  if (!['no-answer','busy','failed'].includes(DialCallStatus) || !Caller) return res.status(200).send('OK');

  const { rows } = await pool.query('SELECT * FROM users WHERE twilio_number=$1', [Called]);
  const user = rows[0];
  if (!user || !isActive(user)) return res.status(200).send('OK');

  const afterHours = !isBusinessHours(user);
  const message = afterHours ? (user.after_hours_message || user.custom_message) : user.custom_message;

  try {
    await twilioClient.messages.create({ body: message, from: user.twilio_number, to: Caller });
    await pool.query(`
      INSERT INTO leads (id, user_id, caller_phone, after_hours)
      VALUES ($1,$2,$3,$4)
    `, [uuidv4(), user.id, Caller, afterHours]);
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
  const { customMessage, afterHoursMessage, businessHours, timezone } = req.body;
  await pool.query(`
    UPDATE users SET
      custom_message = COALESCE($1, custom_message),
      after_hours_message = COALESCE($2, after_hours_message),
      business_hours = COALESCE($3, business_hours),
      timezone = COALESCE($4, timezone)
    WHERE id=$5
  `, [customMessage||null, afterHoursMessage||null,
      businessHours?JSON.stringify(businessHours):null,
      timezone||null, req.params.userId]);
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
  try { await twilioClient.messages.create({ body: sms, from: user.twilio_number, to: user.business_phone }); }
  catch(e) { console.error('Contractor SMS:', e.message); }
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
  const dialCode = `*61*${digits}#`;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: "You're live on CallLocally — one step left",
      html: `<div style="font-family:sans-serif;max-width:520px">
        <h2 style="color:#FF5C1A">Welcome, ${user.name}! 🎉</h2>
        <p>Your toll-free CallLocally number:</p>
        <p style="font-size:32px;font-weight:700;color:#FF5C1A">${num}</p>
        <hr>
        <h3>Forward unanswered calls (2 min)</h3>
        <p><b>iPhone:</b> Settings → Phone → Call Forwarding → On → ${num}</p>
        <p><b>Android:</b> Phone → ⋮ → Settings → Forward when unanswered → ${num}</p>
        <p><b>Fastest — dial:</b> <code>${dialCode}</code></p>
        <p style="background:#fff8f5;border-left:3px solid #FF5C1A;padding:12px;font-size:13px">
          <b>Important:</b> Set forwarding to <b>unanswered calls only</b>, not all calls.
        </p>
        <hr>
        <p>Dashboard: <a href="https://calllocally.com/dashboard">calllocally.com/dashboard</a></p>
        <p style="color:#999;font-size:13px">Questions? hello@calllocally.com</p>
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
      const daysLeft = Math.ceil((new Date(user.trial_ends_at) - Date.now()) / 86400000);
      if ([7,1,0].includes(daysLeft) && user.last_trial_notification !== daysLeft) {
        await sendTrialEmail(user, daysLeft);
        await pool.query('UPDATE users SET last_trial_notification=$1 WHERE id=$2', [daysLeft, user.id]);
      }
    }
  } catch(e) { console.error('Trial check error:', e.message); }
}
setInterval(checkTrials, 60*60*1000);
setTimeout(checkTrials, 8000);

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