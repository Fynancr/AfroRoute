const crypto = require('crypto');

// Generate a deterministic but time-limited 6-digit code
function generateCode(userId, deviceId, salt) {
  const window = Math.floor(Date.now() / (10 * 60 * 1000)); // 10-minute window
  const raw = `${userId}:${deviceId}:${window}:${salt}`;
  const hash = crypto.createHmac('sha256', salt).update(raw).digest('hex');
  // Take first 6 digits from hash
  const num = parseInt(hash.substring(0, 8), 16);
  return String(num % 1000000).padStart(6, '0');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
        subject: 'Your AfroRoute device verification code',
        html: `
          <div style="font-family: 'DM Sans', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #0A2540; font-size: 24px; margin: 0 0 8px;">New device login</h1>
              <p style="color: #64748b; font-size: 15px; margin: 0;">
                We noticed a login from a new device. Use the code below to verify it's you.
              </p>
            </div>
            <div style="background: #f4f6f9; border-radius: 14px; padding: 32px; text-align: center; margin: 24px 0;">
              <div style="font-size: 13px; color: #64748b; margin-bottom: 8px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase;">Verification code</div>
              <div style="font-size: 40px; font-weight: 800; color: #0A2540; letter-spacing: 10px;">${code}</div>
              <div style="font-size: 12px; color: #94a3b8; margin-top: 12px;">Valid for 10 minutes</div>
            </div>
            <p style="color: #64748b; font-size: 13px; line-height: 1.6; text-align: center;">
              If you didn't try to log in, please ignore this email. Your account is safe.
            </p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
            <p style="color: #94a3b8; font-size: 12px; text-align: center;">
              AfroRoute — Trusted shipping between Portugal and Angola
            </p>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send verification email' });
    }

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('Send device verification error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to send email' });
  }
};
