const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

module.exports.config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Missing STRIPE_IDENTITY_WEBHOOK_SECRET env var');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Stripe Identity signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const session = event.data.object;
  const userId = session.metadata?.user_id || session.metadata?.userId || session.client_reference_id || null;

  console.log('Identity webhook received', {
    event_id: event.id,
    event_type: event.type,
    session_id: session.id,
    status: session.status,
    userId,
    metadata_keys: Object.keys(session.metadata || {}),
  });

  if (!userId) {
    return res.status(200).json({ received: true, warning: 'no_user_id' });
  }

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, identity_verification_status, stripe_verification_status')
      .eq('id', userId)
      .maybeSingle();

    const alreadyVerified =
      profile?.identity_verification_status === 'verified' ||
      profile?.stripe_verification_status === 'verified';

    if (event.type === 'identity.verification_session.verified') {
      const now = new Date().toISOString();
      const update = {
        stripe_verification_session_id: session.id,
        stripe_verification_status: 'verified',
        identity_verification_status: 'verified',
        stripe_verification_verified_at: now,
        identity_verification_verified_at: now,
        is_verified_traveler: true,
        is_traveler_verified: true,
        is_sender_verified: true,
        updated_at: now,
      };

      const { data: updated, error: updateErr } = await supabase
        .from('profiles')
        .update(update)
        .eq('id', userId)
        .select('id');
      if (updateErr) throw updateErr;

      if (!updated || updated.length === 0) {
        const { error: fallbackErr } = await supabase
          .from('profiles')
          .update(update)
          .eq('stripe_verification_session_id', session.id);
        if (fallbackErr) throw fallbackErr;
      }
    } else if (event.type === 'identity.verification_session.processing') {
      if (!alreadyVerified) {
        await supabase.from('profiles').update({
          stripe_verification_session_id: session.id,
          stripe_verification_status: 'processing',
          identity_verification_status: 'processing',
          updated_at: new Date().toISOString(),
        }).eq('id', userId);
      }
    } else if (event.type === 'identity.verification_session.requires_input') {
      if (!alreadyVerified) {
        const lastError = session.last_error;
        await supabase.from('profiles').update({
          stripe_verification_session_id: session.id,
          stripe_verification_status: 'requires_input',
          identity_verification_status: 'requires_input',
          identity_verification_last_error: lastError?.reason || lastError?.code || null,
          updated_at: new Date().toISOString(),
        }).eq('id', userId);
      }
    } else if (event.type === 'identity.verification_session.canceled') {
      if (!alreadyVerified) {
        await supabase.from('profiles').update({
          stripe_verification_session_id: session.id,
          stripe_verification_status: 'canceled',
          identity_verification_status: 'failed',
          updated_at: new Date().toISOString(),
        }).eq('id', userId);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Identity webhook handler error:', { message: err.message, event_id: event.id, userId });
    return res.status(500).json({ error: 'Internal error processing webhook' });
  }
};
