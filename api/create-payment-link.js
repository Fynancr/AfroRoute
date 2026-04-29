// api/create-payment-link.js
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

  const {
    amount,
    description,
    conversationId,
    senderId,
    travelerId,
    travelerName,
    senderName,
  } = req.body || {};

  if (!amount || Number(amount) < 100) {
    return res.status(400).json({
      success: false,
      error: 'Amount must be at least €1.00 / 100 cents',
    });
  }

  if (!senderId || !travelerId) {
    return res.status(400).json({
      success: false,
      error: 'Missing senderId or travelerId',
    });
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    'https://www.afroroute.com';

  try {
    const price = await stripe.prices.create({
      unit_amount: Number(amount),
      currency: 'eur',
      product_data: {
        name: description || 'AfroRoute Shipment',
      },
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price: price.id,
          quantity: 1,
        },
      ],
      metadata: {
        conversationId: conversationId || '',
        senderId,
        travelerId,
        travelerName: travelerName || '',
        senderName: senderName || '',
        platformFeePercent: '10',
      },
      after_completion: {
        type: 'redirect',
        redirect: {
          url: `${siteUrl}/?payment=success`,
        },
      },
    });

    return res.status(200).json({
      success: true,
      url: paymentLink.url,
      price_id: price.id,
      payment_link_id: paymentLink.id,
    });
  } catch (err) {
    console.error('Payment link error:', {
      message: err.message,
      hasStripeKey: !!process.env.STRIPE_SECRET_KEY,
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to create payment link',
    });
  }
};
