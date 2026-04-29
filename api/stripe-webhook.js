const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports.config = {
  api: { bodyParser: false },
};

const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const getPlanFromPriceId = (priceId) => {
  if (priceId === process.env.STRIPE_BUSINESS_PRICE_ID) return 'business';
  if (priceId === process.env.STRIPE_PREMIUM_PRICE_ID) return 'pro';
  return 'pro';
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  console.log('Stripe webhook received', { event_id: event.id, event_type: event.type });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.user_id || session.metadata?.userId || session.metadata?.supabase_user_id || session.client_reference_id;
        const priceId = session.metadata?.price_id || null;
        const plan = getPlanFromPriceId(priceId);

        if (userId) {
          const { error } = await supabase.from('profiles').update({
            is_subscribed: true,
            subscription_plan: plan,
            subscription_status: 'active',
            stripe_customer_id: session.customer || null,
            subscription_updated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', userId);
          if (error) throw error;
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const status = sub.status;
        const priceId = sub.items?.data?.[0]?.price?.id || null;
        const plan = getPlanFromPriceId(priceId);
        const isActive = status === 'active' || status === 'trialing';
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

        if (customerId) {
          const { data: profiles, error: fetchErr } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .limit(1);
          if (fetchErr) throw fetchErr;

          if (profiles && profiles[0]) {
            const { error } = await supabase.from('profiles').update({
              is_subscribed: isActive,
              subscription_plan: isActive ? plan : 'free',
              subscription_status: status,
              stripe_subscription_id: sub.id,
              stripe_price_id: priceId,
              subscription_current_period_end: periodEnd,
              updated_at: new Date().toISOString(),
            }).eq('id', profiles[0].id);
            if (error) throw error;
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        if (customerId) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .limit(1);
          if (profiles && profiles[0]) {
            await supabase.from('profiles').update({
              is_subscribed: false,
              subscription_plan: 'free',
              subscription_status: 'canceled',
              updated_at: new Date().toISOString(),
            }).eq('id', profiles[0].id);
          }
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        if (customerId) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .limit(1);
          if (profiles && profiles[0]) {
            await supabase.from('profiles').update({
              subscription_status: 'active',
              updated_at: new Date().toISOString(),
            }).eq('id', profiles[0].id);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        if (customerId) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .limit(1);
          if (profiles && profiles[0]) {
            await supabase.from('profiles').update({
              subscription_status: 'past_due',
              updated_at: new Date().toISOString(),
            }).eq('id', profiles[0].id);
          }
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        if (pi.metadata?.conversation_id) {
          await supabase.from('transactions')
            .update({ status: 'paid', paid_at: new Date().toISOString() })
            .eq('payment_intent_id', pi.id);
        }
        break;
      }

      default:
        return res.status(200).json({ received: true, ignored: true });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handler error:', { message: error.message, event_id: event?.id });
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
};
