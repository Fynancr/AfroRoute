// api/identity-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

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

const fromStripeTimestamp = (ts) => {
  if (!ts || typeof ts !== 'number') return null;
  const d = new Date(ts * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const safeISO = (val) => {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const mapStatus = (stripeStatus, lastError) => {
  if (stripeStatus === 'verified') return 'verified';
  if (stripeStatus === 'processing') return 'processing';
  if (stripeStatus === 'requires_input')
    return lastError?.code === 'consent_declined' ? 'failed' : 'requires_input';
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
    stripe_verification_requires_review: status === 'requires_input',
    identity_verification_last_error: lastError?.reason || lastError?.code || null,
    updated_at: now,
  };

  if (isVerified) {
    const ts = safeISO(verifiedAt) || now;
    update.stripe_verification_verified_at = ts;
    update.identity_verification_verified_at = ts;
    update.is_verified_traveler = true;
    if (role === 'traveler' || role === 'both') update.is_traveler_verified = true;
    if (role === 'sender' || role === 'both') update.is_sender_verified = true;
  }

  // PRIMARY: update by profile id (most reliable)
  let rowsUpdated = 0;
  if (userId) {
    const { data, error } = await supabase
      .from('profiles')
      .update(update)
      .eq('id', userId)
      .select('id');

    if (error) {
      console.error('Supabase update by userId failed:', error.message);
      throw error;
    }
    rowsUpdated = data?.length || 0;
    console.log(`Profile update by userId: ${rowsUpdated} row(s) updated`);
  }

  // FALLBACK: if userId gave 0 rows, try by session ID
  if (rowsUpdated === 0) {
    console.warn(`No rows updated by userId — falling back to session_id: ${sessionId}`);
    const { data: d2, error: e2 } = await supabase
      .from('profiles')
      .update(update)
      .eq('stripe_verification_session_id', sessionId)
      .select('id');

    if (e2) {
      console.error('Supabase fallback update by session_id failed:', e2.message);
      throw e2;
    }
    rowsUpdated = d2?.length || 0;
    console.log(`Profile update by session_id: ${rowsUpdated} row(s) updated`);
  }

  if (rowsUpdated === 0) {
    // This is a real problem — Stripe knows the user is verified but we can't find the profile
    console.error('CRITICAL: 0 profile rows updated. userId:', userId, 'sessionId:', sessionId);
    throw new Error('No profile found to update. userId: ' + userId);
  }

  // Log to verification_logs (non-fatal)
  await supabase.from('verification_logs').insert({
    user_id: userId,
    session_id: sessionId,
    stripe_status: stripeStatus,
    afro_status: status,
    role,
    error_code: lastError?.code || null,
    error_reason: lastError?.reason || null,
    created_at: now,
  }).catch((e) => console.error('Log insert (non-fatal):', e.message));

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

  // Support both metadata.user_id (snake_case) and metadata.userId (camelCase) + client_reference_id
  const userId = s.metadata?.user_id || s.metadata?.userId || s.client_reference_id || null;
  const role = s.metadata?.role || 'both';

  // Safe diagnostic log — no secrets, no document data
  console.log('Identity webhook received', {
    event_id: event.id,
    event_type: event.type,
    session_id: s.id,
    session_status: s.status,
    resolved_userId: userId,
    metadata_keys: Object.keys(s.metadata || {}),
  });

  if (!userId) {
    console.warn('No user ID found in metadata or client_reference_id. Session:', s.id,
      '| metadata:', JSON.stringify(s.metadata || {}));
    // Return 200 so Stripe does not keep retrying a session we can't resolve
    return res.status(200).json({ received: true, warning: 'no_user_id' });
  }

  try {
    switch (event.type) {

      case 'identity.verification_session.verified': {
        const verifiedAt = fromStripeTimestamp(event.created) || new Date().toISOString();
        const status = await updateUser(userId, s.id, 'verified', role, null, verifiedAt);
        console.log(`✅ User ${userId} verified (${role}) — afro_status: ${status}`);
        break;
      }

      case 'identity.verification_session.processing': {
        // Do NOT downgrade if already verified
        const { data: existing } = await supabase
          .from('profiles').select('identity_verification_status').eq('id', userId).maybeSingle();
        if (existing?.identity_verification_status === 'verified') {
          console.log('Skipping processing update — profile already verified');
          break;
        }
        await updateUser(userId, s.id, 'processing', role, null, null);
        break;
      }

      case 'identity.verification_session.requires_input': {
        const { data: existing } = await supabase
          .from('profiles').select('identity_verification_status').eq('id', userId).maybeSingle();
        if (existing?.identity_verification_status === 'verified') {
          console.log('Skipping requires_input update — profile already verified');
          break;
        }
        await updateUser(userId, s.id, 'requires_input', role, s.last_error || null, null);
        break;
      }

      case 'identity.verification_session.canceled': {
        const { data: existing } = await supabase
          .from('profiles').select('identity_verification_status').eq('id', userId).maybeSingle();
        if (existing?.identity_verification_status === 'verified') {
          console.log('Skipping canceled update — profile already verified');
          break;
        }
        await updateUser(userId, s.id, 'canceled', role, s.last_error || null, null);
        break;
      }

      default:
        console.log('Ignored Identity event:', event.type);
        return res.status(200).json({ received: true, ignored: true });
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    // Return 500 so Stripe retries the delivery
    console.error('Identity webhook handler error:', error.message,
      '| event:', event?.id, '| userId:', userId);
    return res.status(500).json({ error: error.message });
  }
};
