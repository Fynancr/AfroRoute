const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error:

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const { email, userId, plan = 'premium' } = req.body;

  if (!email || !userId) {
    return res.status(400).json({ error: 'Missing email or userId' });
  }

  // Map plan name to Stripe price ID
  const priceMap = {
    premium: process.env.STRIPE_PREMIUM_PRICE_ID,
    business: process.env.STRIPE_BUSINESS_PRICE_ID,
  };

  const priceId = priceMap[plan] || process.env.STRIPE_PREMIUM_PRICE_ID;

  if (!priceId) {
    return res.status(500).json({ error: `No price ID configured for plan: ${plan}` });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        trial_period_days: 3,
        metadata: {
          userId,
          plan,
        },
      },
      metadata: {
        userId,
        plan,
      },
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?checkout=success&plan=${plan}`,
      cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?checkout=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
};
