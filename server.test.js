// CallLocally — Unit Tests (server.test.js)
// Run: npm test

const ADMIN_TWILIO_NUMBER = '+19497968059';

function getSenderNumber(user) {
  if (user.tfv_notified === true) return user.twilio_number;
  return ADMIN_TWILIO_NUMBER;
}

function formatPhone(raw) {
  const d = raw.replace(/\D/g, '');
  return d.startsWith('1') ? `+${d}` : `+1${d}`;
}

function getCarrierInstructions(carrier, twilioNumber) {
  const digits = twilioNumber.replace('+', '').replace(/\D/g, '');
  const num = twilioNumber;
  const instructions = {
    tmobile: { name: 'T-Mobile', dialCode: `**61*1${digits}#`, extra: 'T-Mobile tip' },
    att: { name: 'AT&T', dialCode: `*61*${digits}**18#`, extra: '' },
    verizon: { name: 'Verizon', dialCode: `*71${digits}`, extra: '' },
    other: { name: 'your carrier', dialCode: `*61*${digits}**18#`, extra: 'hello@calllocally.com' }
  };
  return instructions[carrier] || instructions.other;
}

function getTradeMessage(businessName, trade, afterHours = false) {
  const biz = businessName;
  const base = {
    plumbing: afterHours ? `Hi! This is ${biz} — closed. What's the plumbing issue and address?` : `Hi! This is ${biz} — on a job. What's the plumbing issue and address?`,
    general: afterHours ? `Hi! This is ${biz} — closed. What service do you need and address?` : `Hi! This is ${biz} — missed your call. What service do you need and address?`,
  };
  return base[trade] || base.general;
}

function isActive(user) {
  if (user.paid) return true;
  if (user.paid_through && new Date(user.paid_through) > new Date()) return true;
  if (user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  if (!user.trial_ends_at && !user.paid && user.tfv_notified !== true && user.tfv_submission_failed !== true) return true;
  return false;
}

function isBusinessHours(user) {
  if (!user.business_hours) return true;
  const now = new Date();
  const tz = user.timezone || 'America/Los_Angeles';
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const hour = local.getHours();
  const day = local.getDay();
  const { startHour = 7, endHour = 20, weekendOn = false } = user.business_hours;
  if (!weekendOn && (day === 0 || day === 6)) return false;
  return hour >= startHour && hour < endHour;
}

// ── TESTS ──

describe('formatPhone', () => {
  test('formats 10-digit number', () => { expect(formatPhone('9497968059')).toBe('+19497968059'); });
  test('formats 11-digit number starting with 1', () => { expect(formatPhone('19497968059')).toBe('+19497968059'); });
  test('strips non-digit characters', () => { expect(formatPhone('(949) 796-8059')).toBe('+19497968059'); });
  test('handles dashes', () => { expect(formatPhone('949-796-8059')).toBe('+19497968059'); });
  test('handles spaces', () => { expect(formatPhone('949 796 8059')).toBe('+19497968059'); });
  test('handles +1 prefix', () => { expect(formatPhone('+1 949 796 8059')).toBe('+19497968059'); });
});

describe('getSenderNumber', () => {
  test('returns contractor number when TFV approved', () => {
    expect(getSenderNumber({ tfv_notified: true, twilio_number: '+18005551234' })).toBe('+18005551234');
  });
  test('returns admin number when TFV not approved', () => {
    expect(getSenderNumber({ tfv_notified: false, twilio_number: '+18005551234' })).toBe(ADMIN_TWILIO_NUMBER);
  });
  test('returns admin number when tfv_notified undefined', () => {
    expect(getSenderNumber({ twilio_number: '+18005551234' })).toBe(ADMIN_TWILIO_NUMBER);
  });
});

describe('isActive', () => {
  test('paid user is active', () => { expect(isActive({ paid: true })).toBe(true); });
  test('valid trial is active', () => {
    expect(isActive({ paid: false, trial_ends_at: new Date(Date.now() + 7*86400000).toISOString() })).toBe(true);
  });
  test('expired trial + notified is NOT active', () => {
    expect(isActive({ paid: false, trial_ends_at: new Date(Date.now() - 86400000).toISOString(), tfv_notified: true })).toBe(false);
  });
  test('pending TFV is active', () => {
    expect(isActive({ paid: false, trial_ends_at: null, tfv_notified: false })).toBe(true);
  });
  test('TFV rejected is NOT active', () => {
    expect(isActive({ paid: false, trial_ends_at: null, tfv_notified: true })).toBe(false);
  });
  test('TFV submission failed is NOT active', () => {
    expect(isActive({ paid: false, trial_ends_at: null, tfv_notified: false, tfv_submission_failed: true })).toBe(false);
  });
  test('paid_through future is active', () => {
    expect(isActive({ paid: false, paid_through: new Date(Date.now() + 30*86400000).toISOString() })).toBe(true);
  });
  test('paid_through past + notified is NOT active', () => {
    expect(isActive({ paid: false, paid_through: new Date(Date.now() - 86400000).toISOString(), tfv_notified: true })).toBe(false);
  });
});

describe('getCarrierInstructions', () => {
  const num = '+18885551234';
  test('T-Mobile code', () => { expect(getCarrierInstructions('tmobile', num).dialCode).toBe('**61*118885551234#'); });
  test('ATT code', () => { expect(getCarrierInstructions('att', num).dialCode).toBe('*61*18885551234**18#'); });
  test('Verizon code', () => { expect(getCarrierInstructions('verizon', num).dialCode).toBe('*7118885551234'); });
  test('unknown falls back to other', () => { expect(getCarrierInstructions('cricket', num).name).toBe('your carrier'); });
  test('all codes contain digits', () => {
    ['tmobile','att','verizon'].forEach(c => expect(getCarrierInstructions(c, num).dialCode).toContain('18885551234'));
  });
});

describe('getTradeMessage', () => {
  test('plumbing returns trade message', () => { expect(getTradeMessage('Acme', 'plumbing')).toContain('plumbing'); });
  test('unknown trade falls back', () => { expect(getTradeMessage('Biz', 'unknown')).toContain('What service'); });
  test('after-hours differs', () => {
    expect(getTradeMessage('B', 'general', false)).not.toBe(getTradeMessage('B', 'general', true));
  });
  test('includes business name', () => { expect(getTradeMessage("Mike's", 'general')).toContain("Mike's"); });
});

describe('isBusinessHours', () => {
  test('no config means always open', () => { expect(isBusinessHours({})).toBe(true); });
  test('with config returns boolean', () => {
    expect(typeof isBusinessHours({ business_hours: {}, timezone: 'America/Los_Angeles' })).toBe('boolean');
  });
});

describe('Lead flow logic', () => {
  test('new signup uses admin number and is active', () => {
    const u = { paid: false, trial_ends_at: null, tfv_notified: false, tfv_submission_failed: false, twilio_number: '+18005559999' };
    expect(isActive(u)).toBe(true);
    expect(getSenderNumber(u)).toBe(ADMIN_TWILIO_NUMBER);
  });
  test('verified user uses own number', () => {
    const u = { paid: false, trial_ends_at: new Date(Date.now()+14*86400000).toISOString(), tfv_notified: true, twilio_number: '+18005559999' };
    expect(isActive(u)).toBe(true);
    expect(getSenderNumber(u)).toBe('+18005559999');
  });
  test('expired user is not active', () => {
    const u = { paid: false, trial_ends_at: new Date(Date.now()-86400000).toISOString(), tfv_notified: true, twilio_number: '+18005559999' };
    expect(isActive(u)).toBe(false);
  });
  test('paid user always active', () => {
    const u = { paid: true, trial_ends_at: new Date(Date.now()-365*86400000).toISOString(), tfv_notified: true, twilio_number: '+18005559999' };
    expect(isActive(u)).toBe(true);
    expect(getSenderNumber(u)).toBe('+18005559999');
  });
});
