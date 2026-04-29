// api/send-device-verification.js
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

const generateCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const hashCode = (code) =>
  crypto
    .createHmac('sha256', process.env.DEVICE_VERIFY_SALT || 'afroroute-device-salt')
    .update(code)
    .digest('hex');

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

  try {
    // Rate limit: max 3 sends per 10 minutes per user
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('login_verification_tokens')
      .select('id')
      .eq('user_id', userId)
      .gte('created_at', tenMinsAgo);

    if (recent && recent.length >= 3) {
      return res.status(429).json({ error: 'Too many attempts. Please wait 10 minutes.' });
    }

    const code = generateCode();
    const tokenHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // Store hashed token in DB
    const { error: insertErr } = await supabase
      .from('login_verification_tokens')
      .insert({
        user_id: userId,
        token_hash: tokenHash,
        device_id_hash: hashCode(deviceId),
        expires_at: expiresAt,
        attempts: 0,
        created_at: now,
      });

    if (insertErr) {
      console.error('Token insert error:', insertErr.message);
      return res.status(500).json({ error: 'Could not create verification token' });
    }

    // Log security event (non-fatal)
    await supabase.from('security_events').insert({
      user_id: userId,
      event_type: 'verification_email_sent',
      metadata: JSON.stringify({ device_id: deviceId }),
      created_at: now,
    }).catch(() => {});

    // Send email via Resend
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'AfroRoute <noreply@afroroute.com>',
        reply_to: process.env.RESEND_REPLY_TO || 'support@afroroute.com',
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
              <p style="color: #94a3b8; font-size: 12px;">
                Need help? Contact <a href="mailto:support@afroroute.com" style="color:#1ABC9C;">support@afroroute.com</a>
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
