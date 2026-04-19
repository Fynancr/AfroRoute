// AfroRoute — Stripe Webhook Handler
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const updateUser = async (userId, isSubscribed, plan) => {
    const body = { is_subscribed: isSubscribed };
    if (plan) body.plan = plan;               // 'premium' or 'business'
    if (!isSubscribed) body.plan = 'free';    // always reset to free on cancel

    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body)
    });
  };

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.supabase_user_id || session.client_reference_id;
        const plan = session.metadata?.plan || 'premium';
        if (userId) await updateUser(userId, true, plan);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = sub.metadata?.supabase_user_id;
        const plan = sub.metadata?.plan || 'premium';
        if (userId) await updateUser(userId, true, plan);
        break;
      }

      case 'invoice.payment_failed':
      case 'customer.subscription.deleted': {
        const obj = event.data.object;
        const subId = obj.subscription || obj.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const userId = sub.metadata?.supabase_user_id;
          if (userId) await updateUser(userId, false, null);
        }
        break;
      }

      case 'customer.subscription.trial_will_end': {
        // Future: trigger email reminder here
        console.log('Trial ending soon:', event.data.object.id);
        break;
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: error.message });
  }
};
