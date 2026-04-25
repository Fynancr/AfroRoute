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

  // Free plan aliases — never go to Stripe. Free plan is the trial.
  const FREE_PLANS = ['free', 'starter', 'gratuito', 'gratuit'];
  if (FREE_PLANS.includes((plan || '').toLowerCase())) {
    return res.status(200).json({
      free: true,
      message: 'Free plan selected. No Stripe Checkout needed.',
    });
  }

  // Pro plan aliases — €9.99/month, no trial, charges immediately
  const PRO_PLANS = ['pro', 'premium', 'afroroute_pro', 'afroroute-pro', 'monthly'];
  // Business plan aliases — €29.99/month, no trial, charges immediately
  const BUSINESS_PLANS = ['business', 'business_pro', 'business-pro', '2999', '29.99'];

  let priceId;
  if (BUSINESS_PLANS.includes((plan || '').toLowerCase())) {
    priceId = process.env.STRIPE_BUSINESS_PRICE_ID;
  } else {
    // Default to Pro for any pro alias
    priceId = process.env.STRIPE_PREMIUM_PRICE_ID;
  }

  if (!priceId) {
    return res.status(500).json({ error: `No price ID configured for plan: ${plan}` });
  }

  // Validate price ID format
  if (!priceId.startsWith('price_')) {
    return res.status(500).json({
      error: `Invalid price ID format for plan "${plan}". Must start with price_. Got: ${priceId.substring(0, 10)}...`
    });
  }

  const planKey = BUSINESS_PLANS.includes((plan || '').toLowerCase()) ? 'business' : 'pro';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      // No trial_period_days — free plan is the trial, paid plans charge immediately
      subscription_data: {
        metadata: { userId, plan: planKey },
      },
      metadata: {
        userId,
        plan: planKey,
        price_id: priceId,
      },
      success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?checkout=success&plan=${planKey}`,
      cancel_url:  `${process.env.NEXT_PUBLIC_SITE_URL}/?checkout=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
};
