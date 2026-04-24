// api/send-device-verification.js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

// Simple 6-digit code generator
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

// Simple hash
const hashCode = async (code) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(code + process.env.DEVICE_VERIFY_SALT || 'afroroute_salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('');
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, userId, deviceId } = req.body;
  if (!email || !userId) return res.status(400).json({ error: 'Missing required fields' });

  try {
    // Rate limit: max 3 sends per 10 minutes per user
    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('login_verification_tokens')
      .select('id')
      .eq('user_id', userId)
      .gte('created_at', tenMinsAgo);

    if (recent && recent.length >= 3) {
      return res.status(429).json({ error: 'Too many verification attempts. Please wait 10 minutes.' });
    }

    const code = generateCode();
    const tokenHash = await hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 min

    // Store hashed token
    await supabase.from('login_verification_tokens').insert({
      user_id: userId,
      token_hash: tokenHash,
      device_id_hash: deviceId || 'unknown',
      expires_at: expiresAt,
      attempts: 0,
    });

    // Log security event
    await supabase.from('security_events').insert({
      user_id: userId,
      event_type: 'verification_email_sent',
      metadata: JSON.stringify({ device_id: deviceId }),
      created_at: new Date().toISOString(),
    }).catch(() => {});

    // Send email via Supabase (using our Resend SMTP)
    // We send a simple transactional email using fetch to Resend API
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'AfroRoute <hello@afroroute.com>',
          to: [email],
          subject: `${code} — Your AfroRoute security code`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f0f4f8">
              <div style="background:#0A2540;borderRadius:12px;padding:24px;text-align:center;margin-bottom:20px">
                <div style="font-size:24px;font-weight:800;color:#fff">✈️ AfroRoute</div>
              </div>
              <div style="background:#fff;border-radius:12px;padding:24px">
                <h2 style="color:#0A2540;margin:0 0 12px">New device login</h2>
                <p style="color:#475569;font-size:14px;line-height:1.6">We noticed a login from a new device. Use this code to verify:</p>
                <div style="background:#f0f4f8;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
                  <div style="font-size:36px;font-weight:800;color:#0A2540;letter-spacing:8px">${code}</div>
                  <div style="font-size:12px;color:#94a3b8;margin-top:8px">Expires in 10 minutes</div>
                </div>
                <p style="color:#94a3b8;font-size:12px">If you didn't try to log in, please secure your account by changing your password.</p>
              </div>
            </div>`,
        }),
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Send device verification error:', error.message);
    return res.status(500).json({ error: 'Could not send verification email' });
  }
};
