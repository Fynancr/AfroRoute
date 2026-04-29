const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ success: false, error: 'Stripe secret key is not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({ success: false, error: 'Missing email' });
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    'https://www.afroroute.com';

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });

    if (!customers.data.length) {
      return res.status(404).json({
        success: false,
        error: 'No Stripe customer found for this email',
      });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: `${siteUrl}/`,
    });

    return res.status(200).json({
      success: true,
      url: portalSession.url,
    });
  } catch (err) {
    console.error('Stripe portal error:', {
      message: err.message,
      email_domain: email.split('@')[1] || 'unknown',
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to create portal session',
    });
  }
};
