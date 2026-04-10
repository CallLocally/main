const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const BUSINESS_PHONE = '+16199429500';
const TWILIO_PHONE = '+19497968059';
const RAILWAY_URL = 'https://main-production-147d.up.railway.app';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.get('/api/forward', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" statusCallback="${RAILWAY_URL}/api/call-status" statusCallbackEvent="completed,no-answer">${BUSINESS_PHONE}</Dial>
</Response>`);
});

app.post('/api/call-status', async (req, res) => {
  const { CallStatus, DialCallStatus, Caller } = req.body;
  console.log('Status:', CallStatus, DialCallStatus, 'Caller:', Caller);
  
  if (DialCallStatus === 'no-answer' && Caller) {
    try {
      await client.messages.create({
        body: 'Hi! We missed your call. What service do you need?',
        from: TWILIO_PHONE,
        to: Caller
      });
      console.log('SMS sent to:', Caller);
    } catch (e) {
      console.log('Error:', e.message);
    }
  }
  res.status(200).send('OK');
});

app.post('/api/twilio/sms', async (req, res) => {
  const { From, Body } = req.body;
  console.log('SMS:', From, Body);
  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running'));
