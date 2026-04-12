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
if (process.env.STRIPE_SECRET_KEY) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  solo:   { name: 'Solo',   price: 4900,  priceId: process.env.STRIPE_PRICE_SOLO },
  growth: { name: 'Growth', price: 7900,  priceId: process.env.STRIPE_PRICE_GROWTH },
  team:   { name: 'Team',   price: 12900, priceId: process.env.STRIPE_PRICE_TEAM },
};

const DB_FILE = '/tmp/calllocally-db.json';
function loadDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('DB load:', e.message); }
  return { users: {}, leads: [] };
}
function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('DB save:', e.message); }
}
function formatPhone(raw) {
  const d = raw.replace(/\D/g,'');
  return d.startsWith('1') ? `+${d}` : `+1${d}`;
}

// Is user allowed to receive leads? (trial not expired, or paid up, or in grace period)
function isActive(user) {
  if (user.paid) return true;
  if (user.paidThrough && new Date(user.paidThrough) > new Date()) return true;
  if (user.trialEndsAt && new Date(user.trialEndsAt) > new Date()) return true;
  return false;
}

// Is it business hours for this user? (if they set hours)
function isBusinessHours(user) {
  if (!user.businessHours) return true; // no restriction set
  const now = new Date();
  const tz = user.timezone || 'America/Los_Angeles';
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const hour = local.getHours();
  const day = local.getDay(); // 0=Sun, 6=Sat
  const { startHour = 7, endHour = 20, weekendOn = false } = user.businessHours;
  if (!weekendOn && (day === 0 || day === 6)) return false;
  return hour >= startHour && hour < endHour;
}

// ── SIGNUP ──
app.post('/api/signup', async (req, res) => {
  const { name, email, businessName, businessPhone, trade } = req.body;
  if (!name || !email || !businessName || !businessPhone)
    return res.status(400).json({ error: 'name, email, businessName, and businessPhone are required' });
  const db = loadDB();
  if (Object.values(db.users).find(u => u.email === email.toLowerCase()))
    return res.status(400).json({ error: 'Email already registered' });
  const formattedPhone = formatPhone(businessPhone);
  const areaCode = formattedPhone.slice(2,5);
  try {
    let twilioNumber = null;
    try {
      const avail = await client.availablePhoneNumbers('US').local.list({ areaCode, limit: 1 });
      if (avail.length) {
        const p = await client.incomingPhoneNumbers.create({
          phoneNumber: avail[0].phoneNumber,
          voiceUrl: `${RAILWAY_URL}/api/forward`, voiceMethod: 'GET',
          statusCallback: `${RAILWAY_URL}/api/call-status`, statusCallbackMethod: 'POST',
          smsUrl: `${RAILWAY_URL}/api/twilio/sms`, smsMethod: 'POST',
        });
        twilioNumber = p.phoneNumber;
      }
    } catch(e) { console.log('Area code failed:', e.message); }
    if (!twilioNumber) {
      const avail = await client.availablePhoneNumbers('US').local.list({ limit: 1 });
      if (!avail.length) throw new Error('No numbers available');
      const p = await client.incomingPhoneNumbers.create({
        phoneNumber: avail[0].phoneNumber,
        voiceUrl: `${RAILWAY_URL}/api/forward`, voiceMethod: 'GET',
        statusCallback: `${RAILWAY_URL}/api/call-status`, statusCallbackMethod: 'POST',
        smsUrl: `${RAILWAY_URL}/api/twilio/sms`, smsMethod: 'POST',
      });
      twilioNumber = p.phoneNumber;
    }
    const userId = `user_${Date.now()}`;
    db.users[userId] = {
      id: userId, name, email: email.toLowerCase(), businessName,
      businessPhone: formattedPhone, trade: trade || 'general', twilioNumber,
      customMessage: `Hi! This is ${businessName} — sorry we missed your call. We're on a job. What service do you need, and what's the address?`,
      afterHoursMessage: `Hi! This is ${businessName} — we're currently closed. What service do you need? We'll call you back first thing in the morning.`,
      createdAt: new Date().toISOString(),
      trialEndsAt: new Date(Date.now() + 14*24*60*60*1000).toISOString(),
      plan: null, paid: false, paidThrough: null,
      stripeCustomerId: null, stripeSubscriptionId: null,
      businessHours: null, timezone: 'America/Los_Angeles',
    };
    saveDB(db);
    await sendWelcomeEmail(db.users[userId]);
    console.log(`Signup: ${businessName} → ${twilioNumber}`);
    res.json({ success: true, userId, twilioNumber });
  } catch(err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: CHECKOUT ──
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { userId, plan } = req.body;
  if (!userId || !PLANS[plan]) return res.status(400).json({ error: 'userId and plan required' });
  const db = loadDB();
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const planCfg = PLANS[plan];
  if (!planCfg.priceId) return res.status(500).json({ error: `Price ID for ${plan} not set` });
  try {
    let cid = user.stripeCustomerId;
    if (!cid) {
      const c = await stripe.customers.create({ email: user.email, name: user.businessName, metadata: { userId } });
      cid = c.id;
      db.users[userId].stripeCustomerId = cid;
      saveDB(db);
    }
    const trialEnd = new Date(user.trialEndsAt).getTime();
    const now = Date.now();
    const session = await stripe.checkout.sessions.create({
      customer: cid,
      payment_method_types: ['card'],
      line_items: [{ price: planCfg.priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://calllocally.com/dashboard?upgraded=1&userId=${userId}`,
      cancel_url: `https://calllocally.com/dashboard?cancelled=1&userId=${userId}`,
      metadata: { userId, plan },
      // Only apply trial if there are days remaining
      ...(trialEnd > now ? {
        subscription_data: {
          metadata: { userId, plan },
          trial_end: Math.floor(trialEnd / 1000),
        }
      } : {}),
    });
    res.json({ url: session.url });
  } catch(err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: BILLING PORTAL ──
app.post('/api/billing-portal', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { userId } = req.body;
  const db = loadDB();
  const user = db.users[userId];
  if (!user?.stripeCustomerId) return res.status(400).json({ error: 'No billing account' });
  try {
    const s = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `https://calllocally.com/dashboard?userId=${userId}`,
    });
    res.json({ url: s.url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── STRIPE: WEBHOOK ──
app.post('/api/stripe-webhook', async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(err) { return res.status(400).send(`Webhook error: ${err.message}`); }

  const db = loadDB();
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      const { userId, plan } = s.metadata || {};
      if (userId && db.users[userId]) {
        db.users[userId].paid = true;
        db.users[userId].plan = plan;
        db.users[userId].stripeSubscriptionId = s.subscription;
        saveDB(db);
        await sendUpgradeEmail(db.users[userId], plan);
      }
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const user = Object.values(db.users).find(u => u.stripeSubscriptionId === sub.id);
      if (user) {
        db.users[user.id].paid = ['active','trialing'].includes(sub.status);
        if (sub.metadata?.plan) db.users[user.id].plan = sub.metadata.plan;
        saveDB(db);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      // FIX: Grace period — keep service through end of current billing period
      const sub = event.data.object;
      const user = Object.values(db.users).find(u => u.stripeSubscriptionId === sub.id);
      if (user) {
        db.users[user.id].paid = false;
        db.users[user.id].plan = null;
        // current_period_end is the Unix timestamp when their paid period actually ends
        const paidThrough = new Date(sub.current_period_end * 1000).toISOString();
        db.users[user.id].paidThrough = paidThrough;
        saveDB(db);
        await sendCancellationEmail(db.users[user.id], paidThrough);
      }
      break;
    }
    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const user = Object.values(db.users).find(u => u.stripeCustomerId === inv.customer);
      if (user) await sendPaymentFailedEmail(user);
      break;
    }
  }
  res.json({ received: true });
});

// ── CALL FORWARDING ──
app.get('/api/forward', (req, res) => {
  const calledNum = req.query.To || req.body.To;
  const db = loadDB();
  const user = Object.values(db.users).find(u => u.twilioNumber === calledNum);
  const forwardTo = user?.businessPhone;
  res.set('Content-Type', 'text/xml');
  if (!forwardTo) return res.send('<?xml version="1.0"?><Response><Say>This number is not configured.</Say></Response>');
  res.send(`<?xml version="1.0"?><Response><Dial timeout="15" statusCallback="${RAILWAY_URL}/api/call-status" statusCallbackEvent="completed,no-answer,busy,failed" statusCallbackMethod="POST">${forwardTo}</Dial></Response>`);
});

// ── CALL STATUS → SMS on miss ──
app.post('/api/call-status', async (req, res) => {
  const { DialCallStatus, Caller, Called } = req.body;
  if (!['no-answer','busy','failed'].includes(DialCallStatus) || !Caller) return res.status(200).send('OK');

  const db = loadDB();
  const user = Object.values(db.users).find(u => u.twilioNumber === Called);
  if (!user) return res.status(200).send('OK');

  // FIX: Don't text if account is inactive
  if (!isActive(user)) {
    console.log(`Skipping SMS — user ${user.id} inactive`);
    return res.status(200).send('OK');
  }

  // FIX: Use after-hours message if outside business hours
  const afterHours = !isBusinessHours(user);
  const message = afterHours ? (user.afterHoursMessage || user.customMessage) : user.customMessage;

  try {
    await client.messages.create({ body: message, from: user.twilioNumber, to: Caller });
    const db2 = loadDB();
    db2.leads.push({
      id: `lead_${Date.now()}`, userId: user.id, callerPhone: Caller,
      status: 'waiting', service: null, address: null, urgent: false,
      afterHours, conversation: [],
      createdAt: new Date().toISOString(), capturedAt: null,
    });
    saveDB(db2);
  } catch(e) { console.error('SMS error:', e.message); }
  res.status(200).send('OK');
});

// ── INCOMING SMS ──
app.post('/api/twilio/sms', async (req, res) => {
  const { From, To, Body } = req.body;
  const db = loadDB();
  const lead = db.leads.find(l => l.callerPhone === From && l.status === 'waiting' && db.users[l.userId]?.twilioNumber === To);
  const user = lead ? db.users[lead.userId] : null;
  let reply = "Thanks! We got your message and will call you back shortly.";
  if (lead && user && isActive(user)) {
    lead.conversation.push({ from: 'customer', text: Body, time: new Date().toISOString() });
    if (/urgent|emergency|asap|right now|leaking|flooding|no heat|no ac|burst|broken|fire|smoke|gas/i.test(Body)) lead.urgent = true;
    if (!lead.service) lead.service = Body;
    const addr = Body.match(/\d+\s+[\w\s]+(st|ave|rd|blvd|dr|ln|way|ct|pl|street|avenue|road|drive|lane|court|place)/i);
    if (addr && !lead.address) lead.address = addr[0];
    lead.status = 'captured';
    lead.capturedAt = new Date().toISOString();
    saveDB(db);
    await notifyContractor(user, lead);
    reply = lead.urgent
      ? `Got it — this is urgent. ${user.businessName} is being notified now.`
      : `Thanks! ${user.businessName} will call you back soon.`;
  }
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0"?><Response><Message>${reply}</Message></Response>`);
});

// ── DASHBOARD API ──
app.get('/api/leads', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const db = loadDB();
  res.json(db.leads.filter(l => l.userId === userId).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)));
});
app.get('/api/user/:userId', (req, res) => {
  const db = loadDB();
  const u = db.users[req.params.userId];
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { id,name,email,businessName,trade,twilioNumber,customMessage,afterHoursMessage,businessHours,timezone,createdAt,trialEndsAt,plan,paid,paidThrough } = u;
  res.json({ id,name,email,businessName,trade,twilioNumber,customMessage,afterHoursMessage,businessHours,timezone,createdAt,trialEndsAt,plan,paid,paidThrough,active:isActive(u) });
});
app.patch('/api/user/:userId', (req, res) => {
  const { customMessage, afterHoursMessage, businessHours, timezone } = req.body;
  const db = loadDB();
  if (!db.users[req.params.userId]) return res.status(404).json({ error: 'Not found' });
  if (customMessage) db.users[req.params.userId].customMessage = customMessage;
  if (afterHoursMessage) db.users[req.params.userId].afterHoursMessage = afterHoursMessage;
  if (businessHours !== undefined) db.users[req.params.userId].businessHours = businessHours;
  if (timezone) db.users[req.params.userId].timezone = timezone;
  saveDB(db);
  res.json({ success: true });
});
app.get('/dashboard', (req, res) => {
  const p = path.join(__dirname, 'public', 'dashboard.html');
  fs.existsSync(p) ? res.sendFile(p) : res.status(404).send('Not found');
});

// ── EMAIL HELPERS ──
async function notifyContractor(user, lead) {
  const flag = lead.urgent ? '🚨 URGENT — ' : '';
  const sms = `${flag}New lead!\nFrom: ${lead.callerPhone}\nService: ${lead.service||'See reply'}\nAddress: ${lead.address||'Ask when you call'}${lead.afterHours?' \n⏰ After hours':''}`;
  try { await client.messages.create({ body: sms, from: user.twilioNumber, to: user.businessPhone }); }
  catch(e) { console.error('Contractor SMS:', e.message); }
  if (!process.env.SENDGRID_API_KEY || !user.email) return;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: `${flag}New lead from ${lead.callerPhone}${lead.afterHours?' (after hours)':''}`,
      html: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#FF5C1A">${flag}New CallLocally Lead</h2><p><b>Caller:</b> ${lead.callerPhone}</p><p><b>Service:</b> ${lead.service||'Not specified'}</p><p><b>Address:</b> ${lead.address||'Ask when you call'}</p><p><b>Urgent:</b> ${lead.urgent?'Yes 🚨':'No'}</p>${lead.afterHours?'<p><b>⏰ After hours</b></p>':''}<a href="tel:${lead.callerPhone}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">📞 Call back now</a></div>`,
    });
  } catch(e) { console.error('Email:', e.message); }
}
async function sendWelcomeEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  const num = user.twilioNumber;
  const dialCode = `*61*${num.replace('+','').replace(/\D/g,'')}#`;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: "You're live on CallLocally — one step left",
      html: `<div style="font-family:sans-serif;max-width:520px"><h2 style="color:#FF5C1A">Welcome, ${user.name}! 🎉</h2><p>Your CallLocally number:</p><p style="font-size:28px;font-weight:700;letter-spacing:2px">${num}</p><hr><h3>Forward your unanswered calls (2 min)</h3><p><b>iPhone:</b> Settings → Phone → Call Forwarding → On → <code>${num}</code></p><p><b>Android:</b> Phone → ⋮ → Settings → Supplementary services → Forward when unanswered → <code>${num}</code></p><p><b>Fastest — dial this on any phone:</b> <code>${dialCode}</code></p><hr><p>View your leads at <a href="https://calllocally.com/dashboard">calllocally.com/dashboard</a></p><p>Questions? hello@calllocally.com</p></div>`,
    });
  } catch(e) { console.error('Welcome email:', e.message); }
}
async function sendUpgradeEmail(user, plan) {
  if (!process.env.SENDGRID_API_KEY) return;
  const planName = PLANS[plan]?.name || plan;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: `You're on CallLocally ${planName} ✅`,
      html: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#FF5C1A">You're on ${planName}!</h2><p>Hey ${user.name}, your ${planName} plan is now active. Your number <b>${user.twilioNumber}</b> is capturing leads.</p><p>Manage billing at <a href="https://calllocally.com/dashboard">calllocally.com/dashboard</a>.</p></div>`,
    });
  } catch(e) { console.error('Upgrade email:', e.message); }
}
async function sendCancellationEmail(user, paidThrough) {
  if (!process.env.SENDGRID_API_KEY) return;
  const endDate = new Date(paidThrough).toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: 'Your CallLocally subscription has been cancelled',
      html: `<div style="font-family:sans-serif;max-width:480px"><h2>Subscription cancelled</h2><p>Hey ${user.name}, your subscription has been cancelled. You'll continue to receive leads until <b>${endDate}</b>. After that your number will stop forwarding.</p><p>Changed your mind? <a href="https://calllocally.com/dashboard">Reactivate here</a>.</p></div>`,
    });
  } catch(e) { console.error('Cancel email:', e.message); }
}
async function sendPaymentFailedEmail(user) {
  if (!process.env.SENDGRID_API_KEY) return;
  try {
    await sgMail.send({
      to: user.email, from: 'hello@calllocally.com',
      subject: '⚠️ Payment failed — update your card to keep leads coming',
      html: `<div style="font-family:sans-serif;max-width:480px"><h2>Payment failed</h2><p>Hey ${user.name}, we couldn't process your payment. Update your card to keep your CallLocally number active.</p><a href="https://calllocally.com/dashboard" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#FF5C1A;color:white;border-radius:8px;text-decoration:none;font-weight:600">Update payment →</a></div>`,
    });
  } catch(e) { console.error('Payment failed email:', e.message); }
}
async function sendTrialEmail(user, daysLeft) {
  if (!process.env.SENDGRID_API_KEY) return;
  const link = `https://calllocally.com/dashboard?userId=${user.id}`;
  const configs = {
    7: { subject:'⏰ 7 days left on your CallLocally trial', body:`<p>Hey ${user.name}, 7 days left. Solo is just $49/mo — <a href="${link}">upgrade now</a>.</p>` },
    1: { subject:'⚠️ Your CallLocally trial ends tomorrow', body:`<p>Hey ${user.name}, trial ends tomorrow. <a href="${link}">Upgrade now to keep capturing leads →</a></p>` },
    0: { subject:'Your CallLocally trial has ended', body:`<p>Hey ${user.name}, your trial ended. <a href="${link}">Reactivate your account →</a></p>` },
  };
  if (!configs[daysLeft]) return;
  try { await sgMail.send({ to: user.email, from: 'hello@calllocally.com', ...configs[daysLeft], html: `<div style="font-family:sans-serif;max-width:480px">${configs[daysLeft].body}</div>` }); }
  catch(e) { console.error('Trial email:', e.message); }
}

function checkTrials() {
  const db = loadDB();
  Object.values(db.users).forEach(user => {
    if (user.paid) return;
    const daysLeft = Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000);
    if ([7,1,0].includes(daysLeft) && user.lastTrialNotification !== daysLeft) {
      sendTrialEmail(user, daysLeft);
      db.users[user.id].lastTrialNotification = daysLeft;
    }
  });
  saveDB(db);
}
setInterval(checkTrials, 60*60*1000);
setTimeout(checkTrials, 5000);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const p = path.join(__dirname, 'public', 'index.html');
  fs.existsSync(p) ? res.sendFile(p) : res.send('CallLocally is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CallLocally on port ${PORT}`));