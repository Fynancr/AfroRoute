// api/verify-device-code.js
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

const hashCode = async (code) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(code + (process.env.DEVICE_VERIFY_SALT || 'afroroute_salt'));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('');
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, code, deviceId } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const tokenHash = await hashCode(code);
    const now = new Date().toISOString();

    // Find valid unused token
    const { data: tokens } = await supabase
      .from('login_verification_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('token_hash', tokenHash)
      .is('used_at', null)
      .gt('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!tokens || tokens.length === 0) {
      // Log failed attempt
      await supabase.from('security_events').insert({
        user_id: userId,
        event_type: 'failed_verification_attempt',
        metadata: JSON.stringify({ device_id: deviceId }),
        created_at: now,
      }).catch(() => {});

      // Check attempts on latest token
      const { data: latest } = await supabase
        .from('login_verification_tokens')
        .select('*')
        .eq('user_id', userId)
        .is('used_at', null)
        .order('created_at', { ascending: false })
        .limit(1);

      if (latest && latest[0]) {
        const attempts = (latest[0].attempts || 0) + 1;
        await supabase.from('login_verification_tokens')
          .update({ attempts })
          .eq('id', latest[0].id);

        if (attempts >= 5) {
          return res.status(429).json({ error: 'Too many failed attempts. Please request a new code.' });
        }
      }

      return res.status(400).json({ error: 'Invalid or expired code. Please try again.' });
    }

    const token = tokens[0];

    // Check max attempts
    if ((token.attempts || 0) >= 5) {
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new code.' });
    }

    // Mark token as used
    await supabase.from('login_verification_tokens')
      .update({ used_at: now })
      .eq('id', token.id);

    // Save trusted device in DB
    await supabase.from('trusted_devices').upsert({
      user_id: userId,
      device_id_hash: deviceId || 'unknown',
      trusted_at: now,
      last_used_at: now,
    }, { onConflict: 'user_id,device_id_hash' }).catch(() => {});

    // Log security event
    await supabase.from('security_events').insert({
      user_id: userId,
      event_type: 'device_verified',
      metadata: JSON.stringify({ device_id: deviceId }),
      created_at: now,
    }).catch(() => {});

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Verify device code error:', error.message);
    return res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
};
