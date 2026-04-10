const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

console.log('App starting...');

app.post('/api/twilio/missed-call', (req, res) => {
  console.log('Missed call webhook hit:', req.body);
  res.status(200).send('OK');
});

app.post('/api/twilio/sms', (req, res) => {
  console.log('SMS webhook hit:', req.body);
  res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('CallLocally running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port', PORT));
