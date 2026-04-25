const Stripe = require('stripe')
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const {
    amount,          // in cents
    description,
    conversationId,
    senderId,
    travelerId,
    travelerName,
    senderName,
  } = req.body;

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Amount must be at least €1.00 (100 cents)' });
  }

  if (!senderId || !travelerId) {
    return res.status(400).json({ error: 'Missing senderId or travelerId' });
  }

  try {
    // Create a one-time price for this payment
    const price = await stripe.prices.create({
      unit_amount: amount,
      currency: 'eur',
      product_data: {
        name: description || 'AfroRoute Shipment',
      },
    });

    // Create payment link
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
          url: `${process.env.NEXT_PUBLIC_SITE_URL}/?payment=success`,
        },
      },
    });

    return res.status(200).json({
      url: paymentLink.url,
      price_id: price.id,
      payment_link_id: paymentLink.id,
    });
  } catch (err) {
    console.error('Payment link error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create payment link' });
  }
};
