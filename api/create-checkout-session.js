// api/create-checkout-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const ALLOWED_ORIGINS = [
  'https://www.afroroute.com',
  'https://afroroute.com',
];

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app');
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, userId, plan } = req.body || {};

    if (!email || typeof email !== 'string' || !/\S+@\S+\.\S+/.test(email))
      return res.status(400).json({ error: 'Invalid email' });
    if (!userId || typeof userId !== 'string' || userId.length > 100)
      return res.status(400).json({ error: 'Invalid userId' });

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.afroroute.com';

    // Price ID is ALWAYS from server env — never from frontend
    const isPremium = !plan || plan === 'premium';
    const priceId = isPremium
      ? process.env.STRIPE_PREMIUM_PRICE_ID
      : process.env.STRIPE_BUSINESS_PRICE_ID;

    if (!priceId || !priceId.startsWith('price_')) {
      console.error('Missing or invalid price ID for plan:', plan);
      return res.status(500).json({ error: 'Payment configuration error. Please contact support.' });
    }

    // Find or create customer
    const existing = await stripe.customers.list({ email: email.toLowerCase().trim(), limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({
          email: email.toLowerCase().trim(),
          metadata: { supabase_user_id: userId }
        });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { supabase_user_id: userId, plan: plan || 'premium' }
      },
      payment_method_collection: 'always',
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      success_url: `${siteUrl}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}?payment=cancelled`,
      client_reference_id: userId,
      metadata: { supabase_user_id: userId },
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    // Log full error internally, never expose to client
    console.error('Checkout session error:', error.message, '| type:', error.type, '| code:', error.code);
    return res.status(500).json({ error: 'Could not create checkout session. Please try again.' });
  }
};
