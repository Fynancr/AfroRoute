const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, userId, plan } = req.body;
    if (!email || !userId) {
      return res.status(400).json({ error: 'Missing email or userId' });
    }

    // Pick the right price based on plan
    let priceId;
    if (plan === 'business') {
      priceId = (process.env.STRIPE_BUSINESS_PRICE_ID || '').trim();
      if (!priceId) return res.status(500).json({ error: 'STRIPE_BUSINESS_PRICE_ID not set' });
    } else {
      priceId = (process.env.STRIPE_PREMIUM_PRICE_ID || process.env.STRIPE_PRICE_ID || '').trim();
      if (!priceId) return res.status(500).json({ error: 'STRIPE_PREMIUM_PRICE_ID not set' });
    }

    if (!priceId.startsWith('price_')) {
      return res.status(500).json({ error: 'Price ID format invalid: ' + priceId.substring(0, 20) });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://afroroute.com';

    // Find or create Stripe customer
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({ email, metadata: { supabase_user_id: userId } });

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 3,
        metadata: { supabase_user_id: userId, plan: plan || 'premium' }
      },
      payment_method_collection: 'always',
      billing_address_collection: 'auto',
      allow_promotion_codes: true,
      success_url: siteUrl + '?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: siteUrl + '?payment=cancelled',
      client_reference_id: userId,
      metadata: { supabase_user_id: userId, plan: plan || 'premium' },
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Stripe error:', error.message);
    return res.status(500).json({ error: error.message, type: error.type, code: error.code });
  }
};
