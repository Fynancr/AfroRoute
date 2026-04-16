// AfroRoute — Stripe Webhook Handler
// Vercel Serverless Function: /api/stripe-webhook
//
// Environment variables needed in Vercel:
//   STRIPE_SECRET_KEY        → your Stripe secret key
//   STRIPE_WEBHOOK_SECRET    → from Stripe Dashboard → Webhooks → signing secret
//   SUPABASE_URL             → https://fzokrhosmthdiymdewuw.supabase.co
//   SUPABASE_SERVICE_KEY     → your Supabase service_role key (NOT anon key)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

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

  const updateUser = async (userId, isSubscribed) => {
    await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ is_subscribed: isSubscribed })
    });
  };

  try {
    switch (event.type) {

      // ── Payment succeeded / trial started → activate subscription
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.supabase_user_id || session.client_reference_id;
        if (userId) await updateUser(userId, true);
        break;
      }

      // ── Subscription renewed → keep active
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = sub.metadata?.supabase_user_id;
        if (userId) await updateUser(userId, true);
        break;
      }

      // ── Payment failed / subscription cancelled → deactivate
      case 'invoice.payment_failed':
      case 'customer.subscription.deleted': {
        const obj = event.data.object;
        const subId = obj.subscription || obj.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          const userId = sub.metadata?.supabase_user_id;
          if (userId) await updateUser(userId, false);
        }
        break;
      }

      // ── Trial ending soon (3 days notice) — future: send email reminder
      case 'customer.subscription.trial_will_end': {
        console.log('Trial ending soon for subscription:', event.data.object.id);
        break;
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: error.message });
  }
};
