// api/send-device-verification.js
const crypto = require('crypto');

// Generate a deterministic but time-limited 6-digit code
// Same algorithm must be mirrored exactly in verify-device-code.js
function generateCode(userId, deviceId, salt) {
  const window = Math.floor(Date.now() / (10 * 60 * 1000)); // 10-minute window
  const raw = `${userId}:${deviceId}:${window}:${salt}`;
  const hash = crypto.createHmac('sha256', salt).update(raw).digest('hex');
  const num = parseInt(hash.substring(0, 8), 16);
  return String(num % 1000000).padStart(6, '0');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, userId, deviceId } = req.body;

  if (!email || !userId || !deviceId) {
    return res.status(400).json({ error: 'Missing email, userId, or deviceId' });
  }

  const salt = process.env.DEVICE_VERIFY_SALT || 'afroroute-device-salt';
  const code = generateCode(userId, deviceId, salt);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'AfroRoute Security <security@afroroute.com>',
        to: [email],
        subject: `${code} — Your AfroRoute security code`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 20px; background: #f0f4f8;">
            <div style="background: #0A2540; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 20px;">
              <div style="font-size: 24px; font-weight: 800; color: #fff;">✈️ AfroRoute</div>
            </div>
            <div style="background: #fff; border-radius: 12px; padding: 24px;">
              <h2 style="color: #0A2540; margin: 0 0 12px;">New device login</h2>
              <p style="color: #475569; font-size: 14px; line-height: 1.6;">
                We noticed a login from a new device. Use this code to verify it's you:
              </p>
              <div style="background: #f0f4f8; border-radius: 10px; padding: 20px; text-align: center; margin: 20px 0;">
                <div style="font-size: 36px; font-weight: 800; color: #0A2540; letter-spacing: 8px;">${code}</div>
                <div style="font-size: 12px; color: #94a3b8; margin-top: 8px;">Valid for 10 minutes</div>
              </div>
              <p style="color: #94a3b8; font-size: 12px; line-height: 1.6;">
                If you didn't try to log in, please change your password immediately.
              </p>
            </div>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send verification email' });
    }

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('Send device verification error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to send email' });
  }
};
