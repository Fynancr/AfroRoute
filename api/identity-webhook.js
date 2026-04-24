// api/identity-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

// Critical: disable Vercel body parsing so Stripe receives raw buffer
module.exports.config = {
  api: { bodyParser: false },
};

// Read raw body from stream
const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

// Stripe timestamps are Unix seconds. JavaScript Date expects milliseconds.
const fromStripeTimestamp = (ts) => {
  if (!ts || typeof ts !== 'number') return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const safeISO = (val) => {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const mapStatus = (stripeStatus, lastError) => {
  if (stripeStatus === 'verified') return 'verified';
  if (stripeStatus === 'processing') return 'pending';

  if (stripeStatus === 'requires_input') {
    return lastError?.code === 'consent_declined'
      ? 'failed'
      : 'requires_review';
  }

  if (stripeStatus === 'canceled') return 'failed';

  return 'pending';
};

// Non-fatal logging helper.
// If this fails, the webhook should still continue.
const insertVerificationLog = async ({
  userId,
  sessionId,
  stripeStatus,
  afroStatus,
  role,
  lastError,
}) => {
  try {
    const { error } = await supabase
      .from('verification_logs')
      .insert({
        user_id: userId,
        session_id: sessionId,
        stripe_status: stripeStatus,
        afro_status: afroStatus,
        role,
        error_code: lastError?.code || null,
        error_reason: lastError?.reason || null,
        created_at: new Date().toISOString(),
      });

    if (error) {
      console.error('Verification log insert failed:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }
  } catch (error) {
    console.error('Verification log insert crashed:', error.message);
  }
};

// Update user profile in Supabase
const updateUser = async (
  userId,
  sessionId,
  stripeStatus,
  role,
  lastError,
  verifiedAt
) => {
  const status = mapStatus(stripeStatus, lastError);
  const isVerified = status === 'verified';
  const now = new Date().toISOString();

  const update = {
    stripe_verification_session_id: sessionId,
    stripe_verification_status: stripeStatus,
    identity_verification_status: status,
    stripe_verification_last_error: lastError
      ? JSON.stringify(lastError)
      : null,
    stripe_verification_requires_review: status === 'requires_review',
    identity_verification_last_error:
      lastError?.reason || lastError?.code || null,
    updated_at: now,
  };

  if (isVerified) {
    const ts = safeISO(verifiedAt) || now;

    update.stripe_verification_verified_at = ts;
    update.identity_verification_verified_at = ts;
    update.is_verified_traveler = true;

    if (role === 'traveler' || role === 'both') {
      update.is_traveler_verified = true;
    }

    if (role === 'sender' || role === 'both') {
      update.is_sender_verified = true;
    }
  }

  // First try to update by Stripe session ID
  let { data, error } = await supabase
    .from('profiles')
    .update(update)
    .eq('stripe_verification_session_id', sessionId)
    .select('id');

  if (error) {
    console.error('Profile update by session ID failed:', {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      userId,
      sessionId,
    });

    throw error;
  }

  // Fallback: if no row matched the session ID, update by user ID from metadata
  if (!data || data.length === 0) {
    const fallback = await supabase
      .from('profiles')
      .update(update)
      .eq('id', userId)
      .select('id');

    data = fallback.data;
    error = fallback.error;

    if (error) {
      console.error('Profile update by user ID failed:', {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        userId,
        sessionId,
      });

      throw error;
    }
  }

  await insertVerificationLog({
    userId,
    sessionId,
    stripeStatus,
    afroStatus: status,
    role,
    lastError,
  });

  return status;
};

// Main handler
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const secret =
    process.env.STRIPE_IDENTITY_WEBHOOK_SECRET ||
    process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('Missing Stripe identity webhook secret');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Signature verification failed:', err.message);

    return res.status(400).json({
      error: `Webhook error: ${err.message}`,
    });
  }

  const s = event.data.object;
  const userId = s?.metadata?.user_id || null;
  const role = s?.metadata?.role || 'both';

  console.log('Identity webhook:', {
    event_id: event.id,
    event_type: event.type,
    session_id: s?.id,
    session_status: s?.status,
    user_id: userId,
    report_id:
      typeof s?.last_verification_report === 'string'
        ? s.last_verification_report
        : s?.last_verification_report?.id || null,
  });

  if (!userId) {
    console.warn('No user_id in session metadata:', s?.id);

    return res.status(200).json({
      received: true,
      warning: 'no user_id',
    });
  }

  try {
    switch (event.type) {
      case 'identity.verification_session.verified': {
        const verifiedAt =
          fromStripeTimestamp(event.created) || new Date().toISOString();

        const status = await updateUser(
          userId,
          s.id,
          'verified',
          role,
          null,
          verifiedAt
        );

        console.log(`User ${userId} verified (${role}) — status: ${status}`);
        break;
      }

      case 'identity.verification_session.requires_input': {
        await updateUser(
          userId,
          s.id,
          'requires_input',
          role,
          s.last_error || null,
          null
        );
        break;
      }

      case 'identity.verification_session.processing': {
        await updateUser(userId, s.id, 'processing', role, null, null);
        break;
      }

      case 'identity.verification_session.canceled': {
        await updateUser(
          userId,
          s.id,
          'canceled',
          role,
          s.last_error || null,
          null
        );
        break;
      }

      default: {
        console.log('Ignored Identity event:', event.type);

        return res.status(200).json({
          received: true,
          ignored: true,
          type: event.type,
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Identity webhook handler error:', {
      message: error.message,
      event_id: event?.id,
      event_type: event?.type,
      session_id: s?.id,
      user_id: userId,
    });

    return res.status(500).json({
      error: error.message,
    });
  }
};
