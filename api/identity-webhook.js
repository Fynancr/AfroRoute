// api/identity-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

// ── CRITICAL: disable Vercel body parsing so Stripe receives raw buffer ──
export const config = {
  api: {
    bodyParser: false,
  },
};

// Read raw body from stream
const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const mapStatus = (stripeStatus, lastError) => {
  if (stripeStatus === 'verified') return 'verified';
  if (stripeStatus === 'processing') return 'pending';
  if (stripeStatus === 'requires_input') {
    return lastError?.code === 'consent_declined' ? 'failed' : 'requires_review';
  }
  if (stripeStatus === 'canceled') return 'failed';
  return 'pending';
};

const updateUser = async (userId, sessionId, stripeStatus, role, lastError, verifiedAt) => {
  const status = mapStatus(stripeStatus, lastError);
  const isVerified = status === 'verified';
  const now = new Date().toISOString();

  const update = {
    stripe_verification_session_id: sessionId,
    stripe_verification_status: stripeStatus,
    identity_verification_status: status,
    stripe_verification_last_error: lastError ? JSON.stringify(lastError) : null,
    stripe_verification_requires_review: status === 'requires_review',
    identity_verification_last_error: lastError?.reason || lastError?.code || null,
  };

  if (isVerified) {
    update.stripe_verification_verified_at = verifiedAt || now;
    update.identity_verification_verified_at = verifiedAt || now;
    update.is_verified_traveler = true;
    if (role === 'traveler' || role === 'both') update.is_traveler_verified = true;
    if (role === 'sender' || role === 'both') update.is_sender_verified = true;
  }

  const { error } = await supabase.from('profiles')
    .update(update).eq('stripe_verification_session_id', sessionId);
  if (error) throw error;

  // Audit log
  await supabase.from('verification_logs').insert({
    user_id: userId, session_id: sessionId, stripe_status: stripeStatus,
    afro_status: status, role, error_code: lastError?.code || null,
    error_reason: lastError?.reason || null, created_at: now,
  }).catch(e => console.error('Log error (non-fatal):', e.message));

  return status;
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Identity webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const s = event.data.object;
  const userId = s.metadata?.user_id;
  const role = s.metadata?.role || 'both';
  if (!userId) return res.status(200).json({ received: true });

  try {
    switch (event.type) {
      case 'identity.verification_session.verified': {
        const vat = s.last_verification_report
          ? new Date(s.last_verification_report.created * 1000).toISOString()
          : new Date().toISOString();
        const status = await updateUser(userId, s.id, 'verified', role, null, vat);
        console.log(`User ${userId} verified (${role}) — status: ${status}`);
        break;
      }
      case 'identity.verification_session.requires_input':
        await updateUser(userId, s.id, 'requires_input', role, s.last_error || null, null);
        break;
      case 'identity.verification_session.processing':
        await updateUser(userId, s.id, 'processing', role, null, null);
        break;
      case 'identity.verification_session.canceled':
        await updateUser(userId, s.id, 'canceled', role, s.last_error || null, null);
        break;
      default:
        console.log('Unhandled Identity event:', event.type);
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Identity webhook error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
