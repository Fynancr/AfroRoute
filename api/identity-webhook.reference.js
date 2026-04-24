// api/identity-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fzokrhosmthdiymdewuw.supabase.co',
  process.env.SUPABASE_SERVICE_KEY
);

const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const fromStripeTimestamp = (ts) => {
  if (!ts || typeof ts !== 'number') return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const mapStatus = (stripeStatus, lastError) => {
  if (stripeStatus === 'verified') return 'verified';
  if (stripeStatus === 'processing') return 'pending';
  if (stripeStatus === 'requires_input') {
    return lastError?.code === 'consent_declined' ? 'failed' : 'requires_review';
  }
  if (stripeStatus === 'canceled') return 'failed';
  return 'pending';
};

const insertVerificationLog = async ({
  userId,
  sessionId,
  stripeStatus,
  afroStatus,
  role,
  lastError,
  eventId,
}) => {
  try {
    const { error } = await supabase.from('verification_logs').insert({
      user_id: userId,
      session_id: sessionId,
      stripe_status: stripeStatus,
      afro_status: afroStatus,
      role,
      error_code: lastError?.code || null,
      error_reason: lastError?.reason || null,
      event_id: eventId || null,
      created_at: new Date().toISOString(),
    });

    if (error) {
      // Logging is non-fatal. Never make Stripe retry because logging failed.
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

const updateUser = async ({
  userId,
  sessionId,
  stripeStatus,
  role,
  lastError,
  verifiedAt,
  reportId,
  eventId,
}) => {
  const status = mapStatus(stripeStatus, lastError);
  const isVerified = status === 'verified';
  const now = new Date().toISOString();
  const ts = verifiedAt || now;

  const update = {
    stripe_verification_session_id: sessionId,
    stripe_verification_status: stripeStatus,
    identity_verification_status: status,
    stripe_verification_last_error: lastError ? JSON.stringify(lastError) : null,
    stripe_verification_requires_review: status === 'requires_review',
    identity_verification_last_error: lastError?.reason || lastError?.code || null,
    updated_at: now,
  };

  // Only include verified fields when verification is complete.
  if (isVerified) {
    update.stripe_verification_verified_at = ts;
    update.identity_verification_verified_at = ts;
    update.is_verified_traveler = true;

    if (role === 'traveler' || role === 'both') update.is_traveler_verified = true;
    if (role === 'sender' || role === 'both') update.is_sender_verified = true;
  }

  // First try by Stripe session ID.
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

  // Fallback: Stripe event metadata has the user ID. Use it if the session ID was not saved.
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

  // If no profile row exists, do not keep retrying forever. Return 200 with warning after logging.
  if (!data || data.length === 0) {
    console.warn('No profile row matched verification update:', { userId, sessionId });
  }

  await insertVerificationLog({
    userId,
    sessionId,
    stripeStatus,
    afroStatus: status,
    role,
    lastError,
    eventId,
  });

  return status;
};

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('Missing Stripe identity webhook secret');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Stripe Identity signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const session = event?.data?.object;
  const userId = session?.metadata?.user_id || null;
  const role = session?.metadata?.role || 'both';
  const reportId =
    typeof session?.last_verification_report === 'string'
      ? session.last_verification_report
      : session?.last_verification_report?.id || null;

  console.log('Stripe Identity webhook received:', {
    event_id: event.id,
    event_type: event.type,
    session_id: session?.id,
    session_status: session?.status,
    user_id: userId,
    report_id: reportId,
  });

  if (!userId) {
    console.warn('Stripe Identity webhook missing metadata.user_id:', {
      event_id: event.id,
      session_id: session?.id,
    });
    return res.status(200).json({ received: true, warning: 'missing user_id metadata' });
  }

  try {
    switch (event.type) {
      case 'identity.verification_session.verified': {
        const verifiedAt = fromStripeTimestamp(event.created) || new Date().toISOString();
        const status = await updateUser({
          userId,
          sessionId: session.id,
          stripeStatus: 'verified',
          role,
          lastError: null,
          verifiedAt,
          reportId,
          eventId: event.id,
        });

        console.log(`User ${userId} verified via Stripe Identity — status: ${status}`);
        return res.status(200).json({ received: true, status });
      }

      case 'identity.verification_session.requires_input': {
        const status = await updateUser({
          userId,
          sessionId: session.id,
          stripeStatus: 'requires_input',
          role,
          lastError: session.last_error || null,
          verifiedAt: null,
          reportId,
          eventId: event.id,
        });
        return res.status(200).json({ received: true, status });
      }

      case 'identity.verification_session.processing': {
        const status = await updateUser({
          userId,
          sessionId: session.id,
          stripeStatus: 'processing',
          role,
          lastError: null,
          verifiedAt: null,
          reportId,
          eventId: event.id,
        });
        return res.status(200).json({ received: true, status });
      }

      case 'identity.verification_session.canceled': {
        const status = await updateUser({
          userId,
          sessionId: session.id,
          stripeStatus: 'canceled',
          role,
          lastError: session.last_error || null,
          verifiedAt: null,
          reportId,
          eventId: event.id,
        });
        return res.status(200).json({ received: true, status });
      }

      default:
        console.log('Ignored Stripe Identity event:', event.type);
        return res.status(200).json({ received: true, ignored: true, type: event.type });
    }
  } catch (error) {
    console.error('Stripe Identity webhook handler error:', {
      message: error.message,
      event_id: event?.id,
      event_type: event?.type,
      session_id: session?.id,
      user_id: userId,
    });

    return res.status(500).json({ error: error.message });
  }
}

module.exports = handler;

// Important: assign config AFTER module.exports = handler.
// Assigning module.exports.config before module.exports = handler gets overwritten.
module.exports.config = {
  api: { bodyParser: false },
};
