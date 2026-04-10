// CallLocally - API Routes
// Simple Express/Next.js API structure

const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const bodyParser = require('body-parser');

// Initialize
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Environment variables (set these in .env)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = 'hello@calllocally.com';

// Initialize clients
const twilioClient = TWILIO_ACCOUNT_SID ? new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

// In-memory storage (replace with DB in production)
const businesses = new Map();
const leads = new Map();
const conversations = new Map();

// ============================================
// WEBHOOKS
// ============================================

// Twilio webhook for missed calls
app.post('/api/twilio/missed-call', async (req, res) => {
  const { From: callerPhone, To: businessPhone } = req.body;
  
  console.log(`Missed call from ${callerPhone} to ${businessPhone}`);
  
  // Find business by phone
  const business = Array.from(businesses.values()).find(b => b.phoneNumber === businessPhone);
  
  if (!business) {
    console.log('Business not found for', businessPhone);
    return res.status(200).send('OK');
  }
  
  // Create new lead
  const leadId = `lead_${Date.now()}`;
  const lead = {
    id: leadId,
    businessId: business.id,
    callerPhone,
    serviceType: null,
    address: null,
    urgency: null,
    callbackTime: null,
    status: 'new',
    step: 'service', // service -> address -> urgency -> callback -> done
    createdAt: new Date().toISOString()
  };
  
  leads.set(leadId, lead);
  
  // Send initial SMS
  await sendSMS(callerPhone, `Hi! This is ${business.businessName}. We missed your call. What service do you need?`);
  
  res.status(200).send('OK');
});

// Twilio webhook for incoming SMS
app.post('/api/twilio/sms', async (req, res) => {
  const { From: callerPhone, Body: message } = req.body;
  
  console.log(`SMS from ${callerPhone}: ${message}`);
  
  // Find lead for this caller
  const lead = Array.from(leads.values())
    .filter(l => l.callerPhone === callerPhone && l.status === 'new')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  
  if (!lead) {
    console.log('No active lead found for', callerPhone);
    return res.status(200).send('OK');
  }
  
  // Handle opt-out
  if (message.trim().toUpperCase() === 'STOP') {
    await sendSMS(callerPhone, 'You have been unsubscribed. Reply START to re-subscribe.');
    return res.status(200).send('OK');
  }
  
  // Process conversation based on current step
  const response = await processLeadStep(lead, message);
  
  // Update lead
  leads.set(lead.id, lead);
  
  // Send response
  if (response) {
    await sendSMS(callerPhone, response);
  }
  
  // If conversation complete, send to business
  if (lead.step === 'done') {
    await sendLeadToBusiness(lead);
  }
  
  res.status(200).send('OK');
});

// ============================================
// BUSINESS MANAGEMENT
// ============================================

// Register new business
app.post('/api/businesses', (req, res) => {
  const { email, businessName, phoneNumber, notificationSms, notificationEmail, timezone } = req.body;
  
  const business = {
    id: `biz_${Date.now()}`,
    email,
    businessName,
    phoneNumber,
    forwardingNumber: TWILIO_PHONE_NUMBER, // Would generate new number in production
    notificationSms: notificationSms || phoneNumber,
    notificationEmail: notificationEmail || email,
    timezone: timezone || 'America/New_York',
    afterHoursEnabled: false,
    plan: 'trial',
    trialExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString()
  };
  
  businesses.set(business.id, business);
  
  res.json({ business, forwardingNumber: business.forwardingNumber });
});

// Get business by ID
app.get('/api/businesses/:id', (req, res) => {
  const business = businesses.get(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  res.json(business);
});

// Update business settings
app.put('/api/businesses/:id', (req, res) => {
  const business = businesses.get(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });
  
  Object.assign(business, req.body);
  businesses.set(business.id, business);
  
  res.json(business);
});

// Get leads for business
app.get('/api/businesses/:id/leads', (req, res) => {
  const businessLeads = Array.from(leads.values())
    .filter(l => l.businessId === req.params.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  res.json(businessLeads);
});

// ============================================
// LEAD PROCESSING
// ============================================

async function processLeadStep(lead, message) {
  const msg = message.trim();
  
  switch (lead.step) {
    case 'service':
      lead.serviceType = msg;
      lead.step = 'address';
      return 'Got it. What\'s the service address or zip code?';
    
    case 'address':
      lead.address = msg;
      lead.step = 'urgency';
      return 'Is this urgent? (Y/N)';
    
    case 'urgency':
      lead.urgency = msg.toUpperCase().startsWith('Y') ? 'urgent' : 'not_urgent';
      lead.step = 'callback';
      return 'What\'s the best time to call you back?';
    
    case 'callback':
      lead.callbackTime = msg;
      lead.step = 'done';
      lead.status = 'qualified';
      
      // Generate summary
      lead.summary = generateLeadSummary(lead);
      
      return 'Thanks! We\'ve sent your info to the business. They\'ll call you soon!';
    
    default:
      return 'Thanks for reaching out. A team member will be in touch.';
  }
}

function generateLeadSummary(lead) {
  return `
New Lead Summary
----------------
Service: ${lead.serviceType}
Address: ${lead.address}
Urgency: ${lead.urgency}
Best Callback: ${lead.callbackTime}
Caller: ${lead.callerPhone}
  `.trim();
}

async function sendSMS(to, message) {
  if (!twilioClient || !TWILIO_PHONE_NUMBER) {
    console.log(`[MOCK SMS] To: ${to}, Message: ${message}`);
    return;
  }
  
  await twilioClient.messages.create({
    body: message,
    from: TWILIO_PHONE_NUMBER,
    to: to
  });
}

async function sendLeadToBusiness(lead) {
  const business = businesses.get(lead.businessId);
  if (!business) return;
  
  const summary = lead.summary;
  
  // Send SMS to business
  if (business.notificationSms) {
    await sendSMS(business.notificationSms, `📞 New Lead!\n${summary}`);
  }
  
  // Send email to business
  if (business.notificationEmail && sgMail) {
    const msg = {
      to: business.notificationEmail,
      from: FROM_EMAIL,
      subject: `📞 New Lead - ${lead.serviceType}`,
      text: summary
    };
    await sgMail.send(msg);
  }
}

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CallLocally API running on port ${PORT}`);
});

module.exports = app;