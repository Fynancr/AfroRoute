const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { amount, description, conversationId, senderId, travelerId, travelerName, senderName } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Minimum amount is €1.00' });
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://afroroute.com';

    // Create a one-time price
    const price = await stripe.prices.create({
      currency: 'eur',
      unit_amount: amount,
      product_data: {
        name: description || 'AfroRoute Shipment Payment',
        metadata: { conversation_id: conversationId||'', traveler_id: travelerId||'', sender_id: senderId||'' }
      },
    });

    // Create payment link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      after_completion: {
        type: 'redirect',
        redirect: { url: siteUrl + '?payment=shipment_success' }
      },
      metadata: {
        conversation_id: conversationId || '',
        sender_id: senderId || '',
        traveler_id: travelerId || '',
        traveler_name: travelerName || '',
        sender_name: senderName || '',
        amount_eur: (amount / 100).toFixed(2),
        platform_fee_eur: (amount / 100 * 0.10).toFixed(2),
        traveler_payout_eur: (amount / 100 * 0.90).toFixed(2),
      },
      payment_method_types: ['card'],
      allow_promotion_codes: false,
    });

    return res.status(200).json({ 
      url: paymentLink.url,
      price_id: price.id,
      payment_link_id: paymentLink.id
    });

  } catch (error) {
    console.error('Payment link error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
