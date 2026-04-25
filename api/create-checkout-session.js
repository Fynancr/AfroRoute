// api/create-checkout-session.js
// AfroRoute — Stripe Checkout Session
// Safe server-side checkout creation for subscription plans.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const ALLOWED_ORIGINS = [
  'https://www.afroroute.com',
  'https://afroroute.com',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    origin.endsWith('.vercel.app') ||
    origin.includes('localhost');

  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

function normalizePlan(plan) {
  const raw = String(plan || 'premium').trim().toLowerCase();

  // Accept the plan names your frontend may already be using.
  if (['premium', 'pro', 'afroroute_pro', 'afroroute-pro', 'monthly', 'basic'].includes(raw)) {
    return 'premium';
  }

  if (['business', 'biz', 'business_pro', 'business-pro', '2999', '29.99'].includes(raw)) {
    return 'business';
  }

  // Free plan should not create Stripe Checkout.
  if (['free', 'starter', 'trial'].includes(raw)) {
    return 'free';
  }

  return null;
}

function getPriceId(plan) {
  if (plan === 'premium') return process.env.STRIPE_PREMIUM_PRICE_ID;
  if (plan === 'business') return process.env.STRIPE_BUSINESS_PRICE_ID;
  return null;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Missing STRIPE_SECRET_KEY');
    return res.status(500).json({ error: 'Payment configuration error. Please contact support.' });
  }

  try {
    const body = req.body || {};
    const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const plan = normalizePlan(body.plan);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    if (!userId || userId.length > 120) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    if (!plan) {
      return res.status(400).json({
        error: 'Invalid plan. Use premium/pro or business.'
      });
    }

    if (plan === 'free') {
      return res.status(200).json({
        free: true,
        message: 'Free plan selected. No Stripe Checkout needed.'
      });
    }

    const priceId = getPriceId(plan);

    if (!priceId || !priceId.startsWith('price_')) {
      console.error('Missing or invalid Stripe price ID', {
        plan,
        hasPremium: Boolean(process.env.STRIPE_PREMIUM_PRICE_ID),
        hasBusiness: Boolean(process.env.STRIPE_BUSINESS_PRICE_ID),
      });

      return res.status(500).json({
        error: `Payment configuration error for ${plan} plan. Please contact support.`
      });
    }

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.SITE_URL ||
      'https://www.afroroute.com';

    // Stripe customer lookup/creation is server-side only.
    const existing = await stripe.customers.list({
      email,
      limit: 1,
    });

    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({
          email,
          metadata: {
            supabase_user_id: userId,
            platform: 'afroroute',
          },
        });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          supabase_user_id: userId,
          plan,
          platform: 'afroroute',
        },
      },
      payment_method_collection: 'always',
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      success_url: `${siteUrl}?payment=success&plan=${encodeURIComponent(plan)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}?payment=cancelled&plan=${encodeURIComponent(plan)}`,
      client_reference_id: userId,
      metadata: {
        supabase_user_id: userId,
        plan,
        platform: 'afroroute',
      },
    });

    return res.status(200).json({
      url: session.url,
      session_id: session.id,
      plan,
    });
  } catch (error) {
    console.error('Checkout session error:', {
      message: error.message,
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
    });

    return res.status(500).json({
      error: 'Could not create checkout session. Please try again.'
    });
  }
};
