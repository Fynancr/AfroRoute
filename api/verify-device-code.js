// api/verify-device-code.js
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

const hashCode = (value) =>
  crypto
    .createHmac('sha256', process.env.DEVICE_VERIFY_SALT || 'afroroute-device-salt')
    .update(value)
    .digest('hex');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, code, deviceId } = req.body;

  if (!userId || !code || !deviceId) {
    return res.status(400).json({ error: 'Missing userId, code, or deviceId' });
  }

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid code format' });
  }

  try {
    const tokenHash = hashCode(code);
    const deviceIdHash = hashCode(deviceId);
    const now = new Date().toISOString();

    // Find a valid, unexpired, unexhausted token for this user
    const { data: tokens, error: fetchErr } = await supabase
      .from('login_verification_tokens')
      .select('id, attempts, expires_at')
      .eq('user_id', userId)
      .eq('token_hash', tokenHash)
      .eq('device_id_hash', deviceIdHash)
      .gt('expires_at', now)
      .lt('attempts', 5)
      .order('created_at', { ascending: false })
      .limit(1);

    if (fetchErr) {
      console.error('Token fetch error:', fetchErr.message);
      return res.status(500).json({ error: 'Verification failed' });
    }

    if (!tokens || tokens.length === 0) {
      // Increment attempts on any matching token (even expired) to track brute force
      await supabase
        .from('login_verification_tokens')
        .update({ attempts: supabase.rpc('increment', { x: 1 }) })
        .eq('user_id', userId)
        .catch(() => {});

      return res.status(401).json({
        success: false,
        error: 'Invalid or expired code. Please request a new one.',
      });
    }

    // Valid — delete the token (one-time use)
    await supabase
      .from('login_verification_tokens')
      .delete()
      .eq('id', tokens[0].id)
      .catch(() => {});

    // Record trusted device
    await supabase
      .from('trusted_devices')
      .upsert({
        user_id: userId,
        device_id_hash: deviceIdHash,
        trusted_at: now,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      }, { onConflict: 'user_id,device_id_hash' })
      .catch(() => {});

    // Log security event (non-fatal)
    await supabase.from('security_events').insert({
      user_id: userId,
      event_type: 'device_verified',
      metadata: JSON.stringify({ device_id_hash: deviceIdHash }),
      created_at: now,
    }).catch(() => {});

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Verify device code error:', err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
