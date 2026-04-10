const express = require('express');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// CONFIG - replace with your numbers
const BUSINESS_PHONE = '+16199429500';  // YOUR REAL PHONE
const TWILIO_PHONE = '+19497968059';    // YOUR TWILIO NUMBER

// Twilio client
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Forward call to business phone
app.get('/api/forward', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15" statusCallback="/api/call-status" statusCallbackEvent="completed,no-answer">${BUSINESS_PHONE}</Dial>
</Response>`);
});

// Handle call status - send SMS if no answer
app.post('/api/call-status', async (req, res) => {
  const { CallStatus, DialCallStatus, Caller } = req.body;
  console.log('Call status:', CallStatus, DialCallStatus);
  
  if (DialCallStatus === 'no-answer') {
    // Send SMS to caller
    try {
      await client.messages.create({
        body: 'Hi! We missed your call. What service do you need?',
        from: TWILIO_PHONE,
        to: Caller
      });
      console.log('SMS sent to:', Caller);
    } catch (e) {
      console.log('SMS error:', e.message);
    }
  }
  res.status(200).send('OK');
});

// Voice webhook
app.post('/api/twilio/missed-call', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// SMS webhook - handle conversation
app.post('/api/twilio/sms', async (req, res) => {
  const { From, Body } = req.body;
  console.log('SMS from', From, ':', Body);
  
  // Simple auto-response
  await client.messages.create({
    body: 'Thanks! We received your message. A team member will call you shortly.',
    from: TWILIO_PHONE,
    to: From
  });
  
  // Also notify business
  await client.messages.create({
    body: `📞 New lead: ${From} - ${Body}`,
    from: TWILIO_PHONE,
    to: BUSINESS_PHONE
  });
  
  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('CallLocally running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port', PORT));
