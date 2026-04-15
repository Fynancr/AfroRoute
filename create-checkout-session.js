// AfroRoute — Stripe Checkout Session
// Vercel Serverless Function: /api/create-checkout-session
//
// Environment variables needed in Vercel:
//   STRIPE_SECRET_KEY   → your Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_PRICE_ID     → your Stripe Price ID (price_...)
//   NEXT_PUBLIC_SITE_URL → https://afroroute.com (or your Vercel URL)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, userId, priceId } = req.body;

    if (!email || !userId) {
      return res.status(400).json({ error: 'Missing email or userId' });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://project-5z3nd.vercel.app';

    // Create or retrieve Stripe customer
    let customer;
    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      });
    }

    // Create checkout session with 7-day free trial
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId || process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      mode: 'subscription',
      subscription_data: {
        trial_period_days: 7,
        metadata: { supabase_user_id: userId }
      },
      success_url: `${siteUrl}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}?payment=cancelled`,
      client_reference_id: userId,
      metadata: { supabase_user_id: userId },
      allow_promotion_codes: true,
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Stripe error:', error);
    return res.status(500).json({ error: error.message });
  }
};
