// AfroRoute — Stripe Checkout Session
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, userId } = req.body;

    if (!email || !userId) {
      return res.status(400).json({ error: 'Missing email or userId' });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://afroroute.com';
    const priceId = (process.env.STRIPE_PRICE_ID || '').trim();
    const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();

    // Debug: log what we have (first/last 4 chars only for security)
    console.log('Price ID:', priceId ? priceId.substring(0,10)+'...' : 'MISSING');
    console.log('Secret key mode:', secretKey.startsWith('sk_live') ? 'LIVE' : secretKey.startsWith('sk_test') ? 'TEST' : 'MISSING');
    console.log('Site URL:', siteUrl);

    if (!priceId) {
      return res.status(500).json({ error: 'STRIPE_PRICE_ID not set in Vercel environment variables' });
    }

    if (!secretKey) {
      return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set in Vercel environment variables' });
    }

    // Validate price ID format
    if (!priceId.startsWith('price_')) {
      return res.status(500).json({ error: 'STRIPE_PRICE_ID format invalid - must start with price_. Got: ' + priceId.substring(0,20) });
    }

    // Find or create customer
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({ email, metadata: { supabase_user_id: userId } });

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 3,
        metadata: { supabase_user_id: userId }
      },
      payment_method_collection: 'always',
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      success_url: siteUrl + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: siteUrl + '?payment=cancelled',
      client_reference_id: userId,
      metadata: { supabase_user_id: userId },
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Stripe error:', error.message);
    console.error('Stripe error type:', error.type);
    console.error('Stripe error code:', error.code);
    return res.status(500).json({ 
      error: error.message,
      type: error.type,
      code: error.code
    });
  }
};
