const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ success: false, error: 'Stripe secret key is not configured' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { email, userId, plan = 'pro' } = req.body || {};

  if (!email || !userId) return res.status(400).json({ success: false, error: 'Missing email or userId' });

  const normalizedPlan = String(plan || '').toLowerCase();
  const FREE_PLANS = ['free', 'starter', 'gratuito', 'gratuit'];
  const PRO_PLANS = ['pro', 'premium', 'afroroute_pro', 'afroroute-pro', 'monthly'];
  const BUSINESS_PLANS = ['business', 'business_pro', 'business-pro', '2999', '29.99'];

  if (FREE_PLANS.includes(normalizedPlan)) {
    return res.status(200).json({ success: true, free: true, message: 'Free plan selected. No Stripe Checkout needed.' });
  }

  let planKey;
  let priceId;

  if (BUSINESS_PLANS.includes(normalizedPlan)) {
    planKey = 'business';
    priceId = process.env.STRIPE_BUSINESS_PRICE_ID;
  } else if (PRO_PLANS.includes(normalizedPlan)) {
    planKey = 'pro';
    priceId = process.env.STRIPE_PREMIUM_PRICE_ID;
  } else {
    return res.status(400).json({ success: false, error: `Unsupported plan: ${plan}` });
  }

  if (!priceId) return res.status(500).json({ success: false, error: `No price ID configured for plan: ${planKey}` });
  if (!priceId.startsWith('price_')) return res.status(500).json({ success: false, error: `Invalid price ID format for plan "${planKey}".` });

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.afroroute.com';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { userId, user_id: userId, plan: planKey },
      },
      metadata: { userId, user_id: userId, plan: planKey, price_id: priceId },
      success_url: `${siteUrl}/?checkout=success&plan=${encodeURIComponent(planKey)}`,
      cancel_url: `${siteUrl}/?checkout=cancelled`,
    });

    return res.status(200).json({ success: true, url: session.url, session_id: session.id, plan: planKey });
  } catch (err) {
    console.error('Stripe checkout error:', { message: err.message, plan: planKey });
    return res.status(500).json({ success: false, error: 'Failed to create checkout session' });
  }
};
