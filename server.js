const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// YOUR BUSINESS PHONE - replace with your real number
const BUSINESS_PHONE = '+6199429500';

// Forward calls to real phone
app.get('/api/forward', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="15">${BUSINESS_PHONE}</Dial>
</Response>`);
});

// Voice webhook (when call completes without answer)
app.post('/api/twilio/missed-call', (req, res) => {
  console.log('Missed call:', req.body);
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

// SMS webhook
app.post('/api/twilio/sms', (req, res) => {
  console.log('SMS:', req.body);
  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('CallLocally running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port', PORT));
