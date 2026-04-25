// api/create-checkout-session.js
const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const { email, userId, plan = 'pro' } = req.body;

  if (!email || !userId) {
    return res.status(400).json({ error: 'Missing email or userId' });
  }

  // Free plan never goes to Stripe Checkout — free plan is the trial
  if (plan === 'free') {
    return res.status(400).json({ error: 'Free plan does not require checkout' });
  }

  // Map plan name to Stripe price ID
  const priceMap = {
    pro:      process.env.STRIPE_PREMIUM_PRICE_ID,   // €9.99/month
    premium:  process.env.STRIPE_PREMIUM_PRICE_ID,   // alias
    business: process.env.STRIPE_BUSINESS_PRICE_ID,  // €29.99/month
  };

  const priceId = priceMap[plan];

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
      // No trial_period_days — free plan is the trial, paid plans charge immediately
      subscription_data: {
        metadata: {
          userId,
          plan,
        },
      },
      metadata: {
        userId,
        plan,
        price_id: priceId,
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
