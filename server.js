const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/api/twilio/missed-call', (req, res) => {
  console.log('Voice webhook:', req.body);
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

app.post('/api/twilio/sms', (req, res) => {
  console.log('SMS webhook:', req.body);
  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('CallLocally running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port', PORT));
