// api/create-verification-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, email, role } = req.body;
  if (!userId || !role) return res.status(400).json({ error: 'userId and role are required' });
  if (!['sender', 'traveler', 'both'].includes(role))
    return res.status(400).json({ error: 'Invalid role' });

  try {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.afroroute.com';

    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      options: {
        document: {
          allowed_types: ['passport', 'id_card', 'driving_license'],
          require_id_number: false,
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
      metadata: { user_id: userId, email: email || '', role, platform: 'afroroute' },
      return_url: `${siteUrl}?verification=complete`,
    });

    // Persist immediately to DB
    await supabase.from('profiles').update({
      stripe_verification_session_id: session.id,
      stripe_verification_status: 'pending',
      identity_verification_role: role,
      identity_verification_started_at: new Date().toISOString(),
      identity_verification_status: 'pending',
      stripe_verification_last_error: null,
    }).eq('id', userId).then(({ error }) => {
      if (error) console.error('DB update error:', error.message);
    });

    return res.status(200).json({
      session_id: session.id,
      url: session.url,
      status: session.status,
    });
  } catch (error) {
    console.error('Stripe Identity error:', error.message);
    return res.status(500).json({ error: 'Could not start verification. Please try again.' });
  }
};
