const express = require('express');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://main-production-147d.up.railway.app';
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const DB_FILE = '/tmp/calllocally-db.json';

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.error('DB load error:', e.message); }
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
          voiceUrl: `${RAILWAY_URL}/api/forward`,
          voiceMethod: 'GET',
          statusCallback: `${RAILWAY_URL}/api/call-status`,
          statusCallbackMethod: 'POST',
          smsUrl: `${RAILWAY_URL}/api/twilio/sms`,
          smsMethod: 'POST',
        });
        twilioNumber = purchased.phoneNumber;
      }
    } catch (e) { console.log('Area code attempt failed:', e.message); }
    if (!twilioNumber) {
      const available = await client.availablePhoneNumbers('US').local.list({ limit: 1 });
      if (!available.length) throw new Error('No Twilio numbers available');
      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        voiceUrl: `${RAILWAY_URL}/api/forward`,
        voiceMethod: 'GET',
        statusCallback: `${RAILWAY_URL}/api/call-status`,
        statusCallbackMethod: 'POST',
        smsUrl: `${RAILWAY_URL}/api/twilio/sms`,
        smsMethod: 'POST',
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

app.get('/api/forward', (req, res) => {
  const calledNumber = req.query.To || req.body.To;
  const db = loadDB();
  const user = Object.values(db.users).find(u => u.twilioNumber === calledNumber);
  const forwardTo = user ? user.businessPhone : process.env.DEFAULT_BUSINESS_PHONE;
  if (!forwardTo) {
    res.set('Content-Type', 'text/xml');
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured.</Say></Response>');
  }
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="15" statusCallback="${RAILWAY_URL}/api/call-status" statusCallbackEvent="completed,no-answer,busy,failed" statusCallbackMethod="POST">${forwardTo}</Dial></Response>`);
});

app.post('/api/call-status', async (req, res) => {
  const { DialCallStatus, Caller, Called } = req.body;
  console.log(`Call status: ${DialCallStatus} | From: ${Caller} | To: ${Called}`);
  if (['no-answer', 'busy', 'failed'].includes(DialCallStatus) && Caller) {
    const db = loadDB();
    const user = Object.values(db.users).find(u => u.twilioNumber === Called);
    const fromNumber = user ? user.twilioNumber : process.env.TWILIO_PHONE_NUMBER;
    const message = user ? user.customMessage : "Hi! We missed your call. What service do you need and what's your address?";
    try {
      await client.messages.create({ body: message, from: fromNumber, to: Caller });
      if (user) {
        const db2 = loadDB();
        db2.leads.push({ id: `lead_${Date.now()}`, userId: user.id, callerPhone: Caller, status: 'waiting', service: null, address: null, urgent: false, conversation: [], createdAt: new Date().toISOString(), capturedAt: null });
        saveDB(db2);
      }
    } catch (e) { console.error('Text error:', e.message); }
  }
  res.status(200).send('OK');
});

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
    replyText = lead.urgent ? `Thanks! We see this is urgent — expect a call from ${user.businessName} very shortly.` : `Thanks! We have your details and ${user.businessName} will call you back soon.`;
  }
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${replyText}</Message></Response>`);
});

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
      html: `<div style="font-family:sans-serif;max-width:520px"><h2 style="color:#FF5C1A">Welcome, ${user.name}! 🎉</h2><p>Your CallLocally number is ready:</p><p style="font-size:28px;font-weight:700">${num}</p><hr><h3>Forward your unanswered calls (2 min)</h3><p><b>iPhone:</b> Settings → Phone → Call Forwarding → On → ${num}</p><p><b>Android:</b> Phone → Menu → Settings → Supplementary services → Forward when unanswered → ${num}</p><p><b>Fastest:</b> Dial <code>${dialCode}</code> and press call.</p><hr><p>Questions? hello@calllocally.com</p></div>`,
    });
  } catch (e) { console.error('Welcome email error:', e.message); }
}

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
  const { id, name, email, businessName, trade, twilioNumber, customMessage, createdAt, trialEndsAt } = user;
  res.json({ id, name, email, businessName, trade, twilioNumber, customMessage, createdAt, trialEndsAt });
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

async function sendTrialEmail(user, daysLeft) {
  if (!process.env.SENDGRID_API_KEY) return;
  const subjects = { 7: '⏰ 7 days left on your CallLocally trial', 1: '⚠️ Your trial ends tomorrow', 0: 'Your CallLocally trial has ended' };
  const bodies = {
    7: `<p>Hey ${user.name}, you have <b>7 days left</b> on your free trial. Solo plan is just $49/month when ready.</p>`,
    1: `<p>Hey ${user.name}, your trial ends <b>tomorrow</b>. <a href="https://calllocally.com/dashboard">Upgrade now →</a></p>`,
    0: `<p>Hey ${user.name}, your trial has ended. <a href="https://calllocally.com/dashboard">Reactivate your account →</a></p>`,
  };
  if (!subjects[daysLeft]) return;
  try {
    await sgMail.send({ to: user.email, from: 'hello@calllocally.com', subject: subjects[daysLeft], html: `<div style="font-family:sans-serif;max-width:480px">${bodies[daysLeft]}</div>` });
  } catch(e) { console.error('Trial email error:', e.message); }
}

function checkTrials() {
  const db = loadDB();
  Object.values(db.users).forEach(user => {
    if (!user.trialEndsAt || user.paid) return;
    const daysLeft = Math.ceil((new Date(user.trialEndsAt) - Date.now()) / 86400000);
    if ([7,1,0].includes(daysLeft) && user.lastTrialNotification !== daysLeft) {
      sendTrialEmail(user, daysLeft);
      db.users[user.id].lastTrialNotification = daysLeft;
    }
  });
  saveDB(db);
}

setInterval(checkTrials, 60 * 60 * 1000);
setTimeout(checkTrials, 5000);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.send('CallLocally is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CallLocally running on port ${PORT}`));