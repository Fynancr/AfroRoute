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

  try {
    const verificationSession = await stripe.identity.verificationSessions.create({
      type: 'document',
      // client_reference_id gives the webhook a third way to identify the user
      client_reference_id: userId,
      metadata: {
        // Include BOTH formats so webhook works regardless of which key it reads
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
      return_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?verification=complete&signup_step=3`,
    });

    console.log('Verification session created', {
      session_id: verificationSession.id,
      userId,
      role,
    });

    return res.status(200).json({
      url: verificationSession.url,
      session_id: verificationSession.id,
    });
  } catch (err) {
    console.error('Stripe Identity error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create verification session' });
  }
};
