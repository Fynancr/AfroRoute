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

  // ── Update subscription status ─────────────────────────────
  const updateUser = async (userId, isSubscribed, plan) => {
    const body = { is_subscribed: isSubscribed };
    if (plan) body.plan = plan;
    if (!isSubscribed) body.plan = 'free';
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

  // ── Mark shipment transaction as paid ──────────────────────
  const markTransactionPaid = async (conversationId, paymentIntentId) => {
    await fetch(`${supabaseUrl}/rest/v1/transactions?conversation_id=eq.${conversationId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        status: 'paid',
        stripe_payment_intent_id: paymentIntentId || null
      })
    });
  };

  try {
    switch (event.type) {

      // ── Checkout completed (subscriptions AND shipment payments) ──
      case 'checkout.session.completed': {
        const session = event.data.object;

        // Shipment payment — has conversation_id in metadata
        if (session.metadata?.conversation_id) {
          await markTransactionPaid(
            session.metadata.conversation_id,
            session.payment_intent
          );
          break;
        }

        // Subscription payment
        const userId = session.metadata?.supabase_user_id || session.client_reference_id;
        const plan = session.metadata?.plan || 'premium';
        if (userId) await updateUser(userId, true, plan);
        break;
      }

      // ── Payment link completed (shipment payments via payment links) ──
      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        if (intent.metadata?.conversation_id) {
          await markTransactionPaid(
            intent.metadata.conversation_id,
            intent.id
          );
        }
        break;
      }

      // ── Subscription renewed ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = sub.metadata?.supabase_user_id;
        const plan = sub.metadata?.plan || 'premium';
        if (userId) await updateUser(userId, true, plan);
        break;
      }

      // ── Payment failed ──
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const userId = sub.metadata?.supabase_user_id;
        if (userId) await updateUser(userId, false, null);
        break;
      }

      // ── Subscription cancelled ──
      case 'customer.subscription.deleted': {
        const obj = event.data.object;
        const userId = obj.metadata?.supabase_user_id;
        if (userId) {
          await updateUser(userId, false, null);
        } else {
          // Fallback: look up by customer email
          try {
            const customer = await stripe.customers.retrieve(obj.customer);
            if (customer.email) {
              const r = await fetch(`${supabaseUrl}/rest/v1/profiles?email=eq.${customer.email}&select=id`, {
                headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
              });
              const rows = await r.json();
              if (rows && rows[0]) await updateUser(rows[0].id, false, null);
            }
          } catch(e) { console.error('Fallback lookup failed:', e.message); }
        }
        break;
      }

      // ── Trial ending soon — future: send email reminder ──
      case 'customer.subscription.trial_will_end': {
        console.log('Trial ending soon:', event.data.object.id);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: error.message });
  }
};
