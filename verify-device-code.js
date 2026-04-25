const crypto = require('crypto');

// Must match the generation logic in send-device-verification.js exactly
function generateCode(userId, deviceId, salt, windowOffset = 0) {
  const window = Math.floor(Date.now() / (10 * 60 * 1000)) + windowOffset;
  const raw = `${userId}:${deviceId}:${window}:${salt}`;
  const hash = crypto.createHmac('sha256', salt).update(raw).digest('hex');
  const num = parseInt(hash.substring(0, 8), 16);
  return String(num % 1000000).padStart(6, '0');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, code, deviceId } = req.body;

  if (!userId || !code || !deviceId) {
    return res.status(400).json({ error: 'Missing userId, code, or deviceId' });
  }

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid code format' });
  }

  const salt = process.env.DEVICE_VERIFY_SALT || 'afroroute-device-salt';

  // Check current window and previous window (handles edge cases near window boundaries)
  const validCodes = [
    generateCode(userId, deviceId, salt, 0),   // current 10-min window
    generateCode(userId, deviceId, salt, -1),  // previous 10-min window
  ];

  if (validCodes.includes(code)) {
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({
    success: false,
    error: 'Invalid or expired code. Please request a new one.',
  });
};
