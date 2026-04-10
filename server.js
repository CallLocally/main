const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = 'hello@calllocally.com';

const twilioClient = TWILIO_ACCOUNT_SID ? new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

console.log('TWILIO_ACCOUNT_SID:', TWILIO_ACCOUNT_SID ? 'SET' : 'MISSING');
console.log('TWILIO_PHONE_NUMBER:', TWILIO_PHONE_NUMBER ? 'SET' : 'MISSING');

const businesses = new Map();
const leads = new Map();

const testBusiness = { id: 'test_biz', businessName: 'Test Plumbing Co', notificationSms: '+15551234567' };
businesses.set(testBusiness.id, testBusiness);

app.post('/api/twilio/missed-call', async (req, res) => {
  const { From: callerPhone } = req.body;
  console.log('Missed call from:', callerPhone);
  const business = businesses.get('test_biz');
  if (!business) return res.status(200).send('OK');
  
  const leadId = 'lead_' + Date.now();
  const lead = { id: leadId, businessId: 'test_biz', callerPhone, step: 'service', status: 'new', createdAt: new Date().toISOString() };
  leads.set(leadId, lead);
  
  try {
    await twilioClient.messages.create({ body: 'Hi! We missed your call. What service do you need?', from: TWILIO_PHONE_NUMBER, to: callerPhone });
  } catch (e) { console.log('SMS error:', e.message); }
  res.status(200).send('OK');
});

app.post('/api/twilio/sms', async (req, res) => {
  const { From: callerPhone, Body: message } = req.body;
  console.log('SMS from', callerPhone, ':', message);
  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CallLocally running on', PORT));
