// api/create-verification-session.js
const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { userId, email, role = 'both' } = req.body;

  if (!userId || !email) {
    return res.status(400).json({ error: 'Missing userId or email' });
  }

  const return_url = `${process.env.NEXT_PUBLIC_SITE_URL || 'https://www.afroroute.com'}/?verification=complete&signup_step=3`;

  try {
    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      client_reference_id: userId,
      metadata: {
        user_id: userId,
        userId:  userId,
        email,
        role,
        platform: 'afroroute',
      },
      options: {
        document: {
          allowed_types: ['passport', 'id_card', 'driving_license'],
          require_id_number: false,
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
      return_url,
    });

    const urlHost = session.url ? new URL(session.url).host : null;

    console.log('Stripe Identity session created', {
      session_id: session.id,
      status: session.status,
      has_url: !!session.url,
      url_host: urlHost,
      userId,
      return_url,
      live_mode: process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_'),
    });

    return res.status(200).json({
      success: true,
      url: session.url,
      session_id: session.id,
      status: session.status,
      url_host: urlHost,
      has_url: !!session.url,
    });

  } catch (err) {
    console.error('Stripe Identity error:', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Failed to create verification session' });
  }
};
