// AfroRoute — Stripe Customer Portal
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://afroroute.com';

    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length === 0) {
      return res.status(404).json({ error: 'No Stripe customer found for this email' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: siteUrl,  // back to home, not /settings (static site has no /settings route)
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Portal error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
