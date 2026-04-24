// api/create-verification-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co';
const supabaseAdmin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const supabaseAuth = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const allowedOrigins = new Set([
  'https://www.afroroute.com',
  'https://afroroute.com'
]);

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

module.exports = async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { role = 'both' } = req.body || {};
  if (!['sender', 'traveler', 'both'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Login required before starting identity verification.' });
  }

  try {
    const { data: authData, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !authData?.user) {
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }

    const user = authData.user;
    const userId = user.id;
    const email = user.email || '';

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, identity_verification_status, stripe_verification_status, is_verified_traveler, is_traveler_verified, is_sender_verified')
      .eq('id', userId)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      console.error('Profile lookup failed:', profileError);
      return res.status(500).json({ error: 'Could not check verification status.' });
    }

    const alreadyVerified =
      profile?.identity_verification_status === 'verified' ||
      profile?.stripe_verification_status === 'verified' ||
      profile?.is_verified_traveler === true ||
      profile?.is_traveler_verified === true ||
      profile?.is_sender_verified === true;

    if (alreadyVerified) {
      return res.status(200).json({ already_verified: true, status: 'verified' });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.afroroute.com';

    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      options: {
        document: {
          allowed_types: ['passport', 'id_card', 'driving_license'],
          require_id_number: false,
          require_live_capture: true,
          require_matching_selfie: true
        }
      },
      metadata: {
        user_id: userId,
        email,
        role,
        platform: 'afroroute'
      },
      return_url: `${siteUrl}?verification=complete`
    });

    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({
        stripe_verification_session_id: session.id,
        stripe_verification_status: session.status || 'pending',
        identity_verification_role: role,
        identity_verification_started_at: new Date().toISOString(),
        identity_verification_status: 'pending',
        stripe_verification_last_error: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateError) {
      console.error('Failed to persist Stripe verification session:', {
        message: updateError.message,
        details: updateError.details,
        hint: updateError.hint,
        code: updateError.code,
        userId,
        sessionId: session.id
      });
      return res.status(500).json({ error: 'Could not save verification session. Please try again.' });
    }

    return res.status(200).json({
      session_id: session.id,
      url: session.url,
      status: session.status
    });
  } catch (error) {
    console.error('Stripe Identity create session error:', error.message);
    return res.status(500).json({ error: 'Could not start verification. Please try again.' });
  }
};
