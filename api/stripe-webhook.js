// api/stripe-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// IMPORTANT: disable body parsing so Stripe can verify the raw signature
module.exports.config = {
  api: { bodyParser: false },
};

const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  console.log('Stripe webhook received:', event.id, event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.supabase_user_id || session.client_reference_id;
        if (userId) {
          const { error } = await supabase.from('profiles')
            .update({
              is_subscribed: true,
              subscription_updated_at: new Date().toISOString(),
            })
            .eq('id', userId);
          if (error) console.error('DB update error (checkout.completed):', error.message);
          else console.log('Subscription activated for user:', userId);
        } else {
          console.warn('checkout.session.completed: no user ID in metadata');
        }
        break;
      }

      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        if (customerId) {
          const isActive = sub.status === 'active' || sub.status === 'trialing';
          const { data: profiles, error: fetchErr } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .limit(1);
          if (fetchErr) {
            console.error('DB fetch error (subscription):', fetchErr.message);
          } else if (profiles && profiles[0]) {
            const { error } = await supabase.from('profiles')
              .update({ is_subscribed: isActive })
              .eq('id', profiles[0].id);
            if (error) console.error('DB update error (subscription):', error.message);
          }
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const conversationId = pi.metadata?.conversation_id;
        if (conversationId) {
          await supabase.from('transactions')
            .update({ status: 'paid', paid_at: new Date().toISOString() })
            .eq('payment_intent_id', pi.id)
            .catch(e => console.error('Transaction update error:', e.message));
        }
        break;
      }

      default:
        console.log('Stripe webhook ignored:', event.type);
        return res.status(200).json({ received: true, ignored: true });
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Stripe webhook handler error:', error.message, '| event:', event?.id);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
};
