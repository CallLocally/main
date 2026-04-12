const express = require('express');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://calllocally.com';
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

let stripe = null;
if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('REPLACE_ME')) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

const PLANS = {
  solo:   { name: 'Solo',   price: 4900,  priceId: process.env.STRIPE_PRICE_SOLO },
  growth: { name: 'Growth', price: 7900,  priceId: process.env.STRIPE_PRICE_GROWTH },
  team:   { name: 'Team',   price: 12900, priceId: process.env.STRIPE_PRICE_TEAM },
};

const DB_FILE = '/tmp/calllocally-db.json';
function loadDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('DB load error:', e.message); }
  return { users: {}, leads: [] };
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('DB save error:', e.message); }
}
function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
}

// ── SIGNUP ──
app.post('/api/signup', async (req, res) => {
  const { name, email, businessName, businessPhone, trade } = req.body;
  if (!name || !email || !businessName || !businessPhone)
    return res.status(400).json({ error: 'name, email, businessName, and businessPhone are required' });
  const db = loadDB();
  const existing = Object.values(db.users).find(u => u.email === email.toLowerCase());
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const formattedPhone = formatPhone(businessPhone);
  const areaCode = formattedPhone.slice(2, 5);
  try {
    let twilioNumber = null;
    try {
      const available = await client.availablePhoneNumbers('US').local.list({ areaCode, limit: 1 });
      if (available.length > 0) {
        const purchased = await client.incomingPhoneNumbers.create({
          phoneNumber: available[0].phoneNumber,
          voiceUrl: `${RAILWAY_URL}/api/forward`, voiceMethod: 'GET',
          statusCallback: `${RAILWAY_URL}/api/call-status`, statusCallbackMethod: 'POST',
          smsUrl: `${RAILWAY_URL}/api/twilio/sms`, smsMethod: 'POST',
        });
        twilioNumber = purchased.phoneNumber;
      }
    } catch (e) { console.log('Area code attempt failed:', e.message); }
    if (!twilioNumber) {
      const available = await client.availablePhoneNumbers('US').local.list({ limit: 1 });
      if (!available.length) throw new Error('No Twilio numbers available');
      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        voiceUrl: `${RAILWAY_URL}/api/forward`, voiceMethod: 'GET',
        statusCallback: `${RAILWAY_URL}/api/call-status`, statusCallbackMethod: 'POST',
        smsUrl: `${RAILWAY_URL}/api/twilio/sms`, smsMethod: 'POST',
      });
      twilioNumber = purchased.phoneNumber;
    }
    const userId = `user_${Date.now()}`;
    db.users[userId] = {
      id: userId, name, email: email.toLowerCase(), businessName,
      businessPhone: formattedPhone, trade: trade || 'general', twilioNumber,
      customMessage: `Hi! This is ${businessName} — sorry we missed your call. We're on a job right now. What service do you need, and what's the address?`,
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      plan: null, paid: false, paidUntil: null, stripeCustomerId: null, stripeSubscriptionId: null,
    };
    saveDB(db);
    await sendWelcomeEmail(db.users[userId]);
    console.log(`New signup: ${businessName} (${email}) → ${twilioNumber}`);
    res.json({ success: true, userId, twilioNumber, message: `You're all set! Forward unanswered calls to ${twilioNumber}.` });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Could not provision number: ' + err.message });
  }
});

// ── STRIPE: CREATE CHECKOUT ──
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured yet' });
  const { userId, plan } = req.body;
  if (!userId || !plan || !PLANS[plan]) return res.status(400).json({ error: 'userId and plan required' });
  const db = loadDB();
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const planConfig = PLANS[plan];
  if (!planConfig.priceId || planConfig.priceId.includes('REPLACE_ME'))
    return res.status(500).json({ error: 'Stripe price not configured yet' });
  try {
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.businessName, metadata: { userId } });
      customerId = customer.id;
      db.users[userId].stripeCustomerId = customerId;
      saveDB(db);
    }
    // If trial hasn't ended yet, honour remaining trial in Stripe
    const trialEnd = new Date(user.trialEndsAt);
    const now = new Date();
    const trialEndUnix = trialEnd > now ? Math.floor(trialEnd.getTime() / 1000) : undefined;

    const sessionData = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: planConfig.priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://calllocally.com/dashboard?upgraded=1&userId=${userId}`,
      cancel_url: `https://calllocally.com/dashboard?cancelled=1&userId=${userId}`,
      metadata: { userId, plan },
    };
    if (trialEndUnix) {
      sessionData.subscription_data = { trial_end: trialEndUnix, metadata: { userId, plan } };
    }
    const session = await stripe.checkout.sessions.create(sessionData);
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: BILLING PORTAL ──
app.post('/api/billing-portal', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { userId } = req.body;
  const db = loadDB();
  const user = db.users[userId];
  if (!user || !user.stripeCustomerId) return res.status(400).json({ error: 'No billing account found' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `https://calllocally.com/dashboard?userId=${userId}`,
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STRIPE: WEBHOOK ──
app.post('/api/stripe-webhook', async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  const db = loadDB();
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { userId, plan } = session.metadata || {};
      if (userId && db.users[userId]) {
        db.users[userId].paid = true;
        db.users[userId].plan = plan;
        db.users[userId].stripeSubscriptionId = session.subscription;
        saveDB(db);
        await sendUpgradeEmail(db.users[userId], plan);
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const user = Object.values(db.users).find(u => u.stripeSubscriptionId === sub.id);
      if (user) {
        if (sub.metadata?.plan) db.users[user.id].plan = sub.metadata.plan;
        db.users[user.id].paid = ['active','trialing'].includes(sub.status);
        // Track paid-until for grace period
        if (sub.current_period_end) {
          db.users[user.id].paidUntil = new Date(sub.current_period_end * 1000).toISOString();
        }
        saveDB(db);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      // GRACE PERIOD: keep service until end of billing period, not immediately
      const sub = event.data.object;
      const user = Object.values(db.users).find(u => u.stripeSubscriptionId === sub.id);
      if (user) {
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : new Date();
        db.users[user.id].paidUntil = periodEnd.toISOString();
        // Don't set paid=false yet — checkSubscriptionGrace() handles this hourly
        db.users[user.id].cancelledAt = new Date().toISOString();
        saveDB(db);
        await sendCancellationEmail(db.users[user.id], periodEnd);
      }
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const user = Object.values(db.users).find(u => u.stripeCustomerId === invoice.customer);
      if (user) await sendPaymentFailedEmail(user);
      break;
    }
  }
  res.json({ received: true });
});

// ── CALL FORWARDING ──
// FIX: Only forward if call is actually coming FROM the contractor's forwarded line
// Personal calls to the contractor's real phone never touch this endpoint
app.get('/api/forward', (req, res) => {
  const calledNumber = req.query.To || req.body.To;
  const callerNumber = req.query.From || req.body.From;
  const db = loadDB();
  const user = Object.values(db.users).find(u => u.twilioNumber === calledNumber);
  const forwardTo = user ? user.businessPhone : process.env.DEFAULT_BUSINESS_PHONE;

  if (!forwardTo) {
    res.set('Content-Type', 'text/xml');
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured.</Say></Response>');
  }

  // Check if user is active (trial or paid)
  if (user && !isUserActive(user)) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is temporarily inactive. Please contact ${user.businessName} directly.</Say></Response>`);
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="15" statusCallback="${RAILWAY_URL}/api/call-status" statusCallbackEvent="completed,no-answer,busy,failed" statusCallbackMethod="POST">${forwardTo}</Dial></Response>`);
});

// Helper: is user still in active trial or paid period?
function isUserActive(user) {
  if (user.paid) return true;
  // Grace period: cancelled but still within paid period
  if (user.paidUntil && new Date(user.paidUntil) > new Date()) return true;
  // Still in free trial
  if (user.trialEndsAt && new Date(user.trialEndsAt) > new Date()) return true;
  return false;
}

// ── CALL STATUS → fire SMS on missed call ──
// KEY FIX: Only text the caller if the call was a no-answer/busy/failed
// This endpoint is only triggered for calls to the CallLocally number —
// personal calls to the contractor's real phone NEVER hit this endpoint
app.post('/api/call-status', async (req, res) => {
  const { DialCallStatus, Caller, Called } = req.body;
  console.log(`Call status: ${DialCallStatus} | From: ${Caller} | To: ${Called}`);

  if (['no-answer', 'busy', 'failed'].includes(DialCallStatus) && Caller) {
    const db = loadDB();
    const user = Object.values(db.users).find(u => u.twilioNumber === Called);

    // Don't text if user is inactive
    if (user && !isUserActive(user)) {
      console.log(`Skipping SMS — user ${user.id} is inactive`);
      return res.status(200).send('OK');
    }

    const fromNumber = user ? user.twilioNumber : process.env.TWILIO_PHONE_NUMBER;
    const message = user ? user.customMessage : "Hi! We missed your call. What service do you need and what's your address?";
    try {
      await client.messages.create({ body: message, from: fromNumber, to: Caller });
      if (user) {
        const db2 = loadDB();
        db2.leads.push({
          id: `lead_${Date.now()}`, userId: user.id, callerPhone: Caller,
          status: 'waiting', service: null, address: null, urgent: false,
          conversation: [], createdAt: new Date().toISOString(), capturedAt: null
        });
        saveDB(db2);
      }
      console.log(`Text sent to ${Caller}`);
    } catch (e) { console.error('Text error:', e.message); }
  }
  res.status(200).send('OK');
});

// ── INCOMING SMS → parse lead, notify contractor ──
app.post('/api/twilio/sms', async (req, res) => {
  const { From, To, Body } = req.body;
  const db = loadDB();
  const lead = db.leads.find(l => l.callerPhone === From && l.status === 'waiting' && db.users[l.userId]?.twilioNumber === To);
  const user = lead ? db.users[lead.userId] : null;
  let replyText = "Thanks! We got your message and will call you back shortly.";
  if (lead && user) {
    lead.conversation.push({ from: 'customer', text: Body, time: new Date().toISOString() });
    if (/urgent|emergency|asap|right now|leaking|flooding|no heat|no ac|burst|broken|fire|smoke|gas/i.test(Body)) lead.urgent = true;
    if (!lead.service) lead.service = Body;
    const addressMatch = Body.match(/\d+\s+[\w\s]+(st|ave|rd|blvd|dr|ln|way|ct|pl|street|avenue|road|drive|lane|court|place)/i);
    if (addressMatch && !lead.address) lead.address = addressMatch[0];
    lead.status = 'captured';
    lead.capturedAt = new Date().toISOString();
    saveDB(db);
    await notifyContractor(user, lead);
    replyText = lead.urgent
      ? `Thanks! We see this is urgent — expect a call from ${user.businessName} very shortly.`
      : `Thanks! ${user.businessName} will call you back soon.`;
  }
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${replyText}</Message></Response>`);
});

// ── EMAIL HELPERS ──
async function notifyContractor(user, lead) {
  const flag = lead.urgent ? '🚨 URGENT — ' : '';
  const smsBody = `${flag}New lead!\nFrom: ${lead.callerPhone}\nService: ${lead.service || 'See reply'}\nAddress: ${lead.address || 'Ask when you call'}`;
  try { await client.messages.create({ body: smsBody, from: user.twilioNumber, to: user.businessPhone }); }
  catch (e) { console.error('Contractor SMS error:', e.message); }
  if (process.env.SENDGRID_API_KEY && user.email) {
    try {
      await sgMail.send({
        to: user.email, from: 'hello@calllocally.com',
        subject: `${flag}New lead from ${lead.callerPhone}`,
        html: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#FF5C1A">${flag}New CallLocally Lead</h2><p><b>Caller:</b> ${lead.callerPhone}</p><p><b>Service:</b> ${lead.service||'Not specified'}</p><p><b>Address:</b> ${lead.address||'Ask when you call'}</p><p><b>Urgent:</b> ${lead.urgent?'Yes 🚨':'No'}</p><a href="tel:${lead.callerPhone}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">📞 Call back now</a></div>`,
      });
    } catch (e) { console.error('Email error:', e.message); }
  }
}
async function sendWelcomeEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  const num = user.twilioNumber;
  const dialCode = `*61*${num.replace('+','').replace(/\D/g,'')}#`;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: "You're live on CallLocally — one step left",
      html: `<div style="font-family:sans-serif;max-width:520px"><h2 style="color:#FF5C1A">Welcome, ${user.name}! 🎉</h2><p>Your CallLocally number:</p><p style="font-size:28px;font-weight:700">${num}</p><hr><p><b>⚠️ Important:</b> Set your phone to forward <b>unanswered calls only</b> — not all calls.</p><p><b>iPhone:</b> Settings → Phone → Call Forwarding → On → ${num}</p><p><b>Android:</b> Phone → Menu → Settings → Forward when unanswered → ${num}</p><p><b>Fastest:</b> Dial <code>${dialCode}</code> and press call.</p><hr><p>Questions? hello@calllocally.com</p></div>`,
    });
  } catch (e) { console.error('Welcome email error:', e.message); }
}
async function sendUpgradeEmail(user, plan) {
  if (!process.env.SENDGRID_API_KEY) return;
  const planName = PLANS[plan]?.name || plan;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: `You're on CallLocally ${planName} ✅`,
      html: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#FF5C1A">You're on ${planName}!</h2><p>Hey ${user.name}, your ${planName} plan is active. Your number <b>${user.twilioNumber}</b> keeps capturing leads.</p></div>`,
    });
  } catch (e) { console.error('Upgrade email error:', e.message); }
}
async function sendCancellationEmail(user, periodEnd) {
  if (!process.env.SENDGRID_API_KEY) return;
  const endDate = periodEnd ? periodEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'your next billing date';
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: 'Your CallLocally subscription has been cancelled',
      html: `<div style="font-family:sans-serif;max-width:480px"><h2>Subscription cancelled</h2><p>Hey ${user.name}, your subscription is cancelled but your service continues until <b>${endDate}</b>.</p><p>After that, your CallLocally number will stop forwarding. Reactivate anytime at <a href="https://calllocally.com/dashboard">calllocally.com/dashboard</a>.</p></div>`,
    });
  } catch (e) { console.error('Cancellation email error:', e.message); }
}
async function sendPaymentFailedEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: '⚠️ Payment failed — action required',
      html: `<div style="font-family:sans-serif;max-width:480px"><h2>Payment failed</h2><p>Hey ${user.name}, please update your payment method to keep your number active.</p><a href="https://calllocally.com/dashboard" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">Update payment →</a></div>`,
    });
  } catch (e) { console.error('Payment failed email error:', e.message); }
}
async function sendTrialEmail(user, daysLeft) {
  if (!process.env.SENDGRID_API_KEY) return;
  const subjects = { 7: '⏰ 7 days left on your CallLocally trial', 1: '⚠️ Your trial ends tomorrow', 0: 'Your CallLocally trial has ended' };
  const link = `https://calllocally.com/dashboard?userId=${user.id}&upgrade=1`;
  const bodies = {
    7: `<p>Hey ${user.name}, you have <b>7 days left</b> on your free trial. When you're ready, plans start at $49/mo.</p><a href="${link}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">View plans →</a>`,
    1: `<p>Hey ${user.name}, your trial ends <b>tomorrow</b>. Keep capturing leads uninterrupted.</p><a href="${link}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">Upgrade now →</a>`,
    0: `<p>Hey ${user.name}, your trial has ended. Reactivate to keep your number.</p><a href="${link}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">Reactivate →</a>`,
  };
  if (!subjects[daysLeft]) return;
  try { await sgMail.send({ to: user.email, from: 'hello@calllocally.com', subject: subjects[daysLeft], html: `<div style="font-family:sans-serif;max-width:480px">${bodies[daysLeft]}</div>` }); }
  catch (e) { console.error('Trial email error:', e.message); }
}

// ── HOURLY CHECKS ──
function checkTrialsAndGrace() {
  const db = loadDB();
  let changed = false;
  Object.values(db.users).forEach(user => {
    // Trial expiry notifications
    if (!user.paid && !user.cancelledAt && user.trialEndsAt) {
      const daysLeft = Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000);
      if ([7,1,0].includes(daysLeft) && user.lastTrialNotification !== daysLeft) {
        sendTrialEmail(user, daysLeft);
        db.users[user.id].lastTrialNotification = daysLeft;
        changed = true;
      }
    }
    // Grace period expiry — turn off service after billing period ends
    if (user.cancelledAt && user.paidUntil && !user.serviceTerminated) {
      if (new Date(user.paidUntil) < new Date()) {
        db.users[user.id].paid = false;
        db.users[user.id].serviceTerminated = true;
        changed = true;
        console.log(`Service terminated for ${user.id} — grace period ended`);
      }
    }
  });
  if (changed) saveDB(db);
}
setInterval(checkTrialsAndGrace, 60 * 60 * 1000);
setTimeout(checkTrialsAndGrace, 5000);

// ── DASHBOARD API ──
app.get('/api/leads', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const db = loadDB();
  res.json(db.leads.filter(l => l.userId === userId).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)));
});
app.get('/api/user/:userId', (req, res) => {
  const db = loadDB();
  const user = db.users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Not found' });
  const { id, name, email, businessName, trade, twilioNumber, customMessage, createdAt, trialEndsAt, plan, paid, paidUntil, cancelledAt } = user;
  res.json({ id, name, email, businessName, trade, twilioNumber, customMessage, createdAt, trialEndsAt, plan, paid, paidUntil, cancelledAt });
});
app.patch('/api/user/:userId', (req, res) => {
  const { customMessage } = req.body;
  const db = loadDB();
  if (!db.users[req.params.userId]) return res.status(404).json({ error: 'Not found' });
  if (customMessage) db.users[req.params.userId].customMessage = customMessage;
  saveDB(db);
  res.json({ success: true });
});
app.get('/dashboard', (req, res) => {
  const dashPath = path.join(__dirname, 'public', 'dashboard.html');
  if (fs.existsSync(dashPath)) res.sendFile(dashPath);
  else res.status(404).send('Dashboard not found.');
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.send('CallLocally is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CallLocally running on port ${PORT}`));