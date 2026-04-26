const Stripe = require('stripe');

module.exports = async (req, res) => {
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
      metadata: {
        userId,
        email,
        role,
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

    return res.status(200).json({
      url: verificationSession.url,
      session_id: verificationSession.id,
    });
  } catch (err) {
    console.error('Stripe Identity error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create verification session' });
  }
};
