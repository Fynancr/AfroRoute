// api/signup-and-send-confirmation.js
// Creates the Supabase Auth user and sends the official confirmation link through Resend.
// One job only: signup + confirmation email.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, body) {
  return res.status(status).json(body);
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  return domain ? `${name.slice(0, 2)}***@${domain}` : 'invalid';
}

function normalizeSiteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.afroroute.com').replace(/\/$/, '');
}

function safeRedirect(raw) {
  const siteUrl = normalizeSiteUrl();
  try {
    const fallback = `${siteUrl}/auth/callback`;
    const url = new URL(raw || fallback);
    const site = new URL(siteUrl);

    // Only allow AfroRoute domain callbacks. Never allow arbitrary redirects.
    if (url.host !== site.host) return fallback;
    return url.toString();
  } catch (_) {
    return `${siteUrl}/auth/callback`;
  }
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function serviceKeyProblem(serviceKey) {
  if (!serviceKey) return 'SUPABASE_SERVICE_KEY is missing.';
  const payload = decodeJwtPayload(serviceKey);
  // Newer Supabase secret keys may not decode as JWT, so do not reject undecodable keys.
  if (payload && payload.role && payload.role !== 'service_role') {
    return `SUPABASE_SERVICE_KEY is not a service_role key. Current role: ${payload.role}.`;
  }
  return null;
}

function isDuplicateUserMessage(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('already') || s.includes('registered') || s.includes('exists') || s.includes('duplicate');
}

function isRedirectMessage(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('redirect') || s.includes('uri') || s.includes('url') || s.includes('not allowed');
}

function confirmationEmailHtml({ actionLink, replyTo }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0A2540;background:#f7f9fb">
      <div style="text-align:center;margin-bottom:22px">
        <div style="font-size:34px;margin-bottom:8px">✈️</div>
        <h1 style="margin:0;font-size:26px;color:#0A2540">AfroRoute</h1>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
        <h2 style="margin:0 0 12px;font-size:21px;color:#0A2540">Confirm your email</h2>
        <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 24px">
          Welcome to AfroRoute. Click the button below to confirm your email and activate your account.
        </p>
        <p style="margin:28px 0;text-align:center">
          <a href="${actionLink}" style="background:#1ABC9C;color:white;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:bold;display:inline-block">Confirm email</a>
        </p>
        <p style="font-size:13px;line-height:1.6;color:#64748b;margin:0 0 8px">
          If the button does not work, copy and paste this link into your browser:
        </p>
        <p style="font-size:12px;line-height:1.6;word-break:break-all;color:#0A2540;margin:0">${actionLink}</p>
        <p style="font-size:13px;line-height:1.6;color:#94a3b8;margin:24px 0 0">
          If you did not create an AfroRoute account, you can safely ignore this email.
        </p>
      </div>
      <div style="text-align:center;margin-top:20px;font-size:12px;color:#94a3b8;line-height:1.7">
        Need help? Contact <a href="mailto:${replyTo}" style="color:#1ABC9C">${replyTo}</a><br>
        © 2026 AfroRoute · <a href="https://www.afroroute.com" style="color:#1ABC9C">afroroute.com</a>
      </div>
    </div>`;
}

async function generateSignupLinkWithSupabaseJs({ supabase, email, password, redirectTo, metadata }) {
  return supabase.auth.admin.generateLink({
    type: 'signup',
    email,
    password,
    options: {
      redirectTo,
      data: metadata,
    },
  });
}

async function generateSignupLinkWithRest({ email, password, redirectTo, metadata, serviceKey }) {
  const supabaseUrl = process.env.SUPABASE_URL;

  const attempts = [
    {
      label: 'raw_with_redirect_to',
      body: { type: 'signup', email, password, data: metadata, redirect_to: redirectTo },
    },
    {
      label: 'raw_without_redirect',
      body: { type: 'signup', email, password, data: metadata },
    },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    const resp = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(attempt.body),
    });

    const data = await resp.json().catch(() => ({}));
    const actionLink = data?.properties?.action_link || data?.action_link || data?.link;

    if (resp.ok && actionLink) {
      return { data: { ...data, properties: { ...(data.properties || {}), action_link: actionLink } }, error: null, method: attempt.label };
    }

    lastError = data?.message || data?.msg || data?.error || `REST generate_link failed with ${resp.status}`;
    console.warn('signup_generate_link_rest_attempt_failed', { method: attempt.label, status: resp.status, message: lastError });

    if (isDuplicateUserMessage(lastError)) break;
    if (!isRedirectMessage(lastError)) break;
  }

  return { data: null, error: { message: lastError || 'REST generate_link failed' }, method: 'rest_failed' };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'Method not allowed' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (_) {
    return json(res, 400, { success: false, error: 'Invalid JSON body' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  const country = String(body.country || '').trim();
  const wa = String(body.wa || body.whatsapp || '').trim();
  const redirectTo = safeRedirect(body.redirectTo);

  if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { success: false, error: 'Valid email is required' });
  if (!password || password.length < 8) return json(res, 400, { success: false, error: 'Password must be at least 8 characters' });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const from = process.env.RESEND_FROM || 'AfroRoute <noreply@afroroute.com>';
  const replyTo = process.env.RESEND_REPLY_TO || 'support@afroroute.com';

  console.log('signup_confirmation_request', {
    email: maskEmail(email),
    has_supabase_url: !!process.env.SUPABASE_URL,
    has_service_key: !!serviceKey,
    has_resend_key: !!process.env.RESEND_API_KEY,
    redirect_host: (() => { try { return new URL(redirectTo).host; } catch { return 'invalid'; } })(),
    service_key_role: decodeJwtPayload(serviceKey)?.role || 'unknown',
  });

  if (!process.env.SUPABASE_URL || !serviceKey || !process.env.RESEND_API_KEY) {
    return json(res, 500, {
      success: false,
      code: 'MISSING_ENV',
      error: 'Email service is not configured. Check SUPABASE_URL, SUPABASE_SERVICE_KEY, and RESEND_API_KEY in Vercel.',
    });
  }

  const keyProblem = serviceKeyProblem(serviceKey);
  if (keyProblem) {
    console.error('signup_service_key_problem', { message: keyProblem });
    return json(res, 500, {
      success: false,
      code: 'BAD_SERVICE_KEY',
      error: keyProblem,
    });
  }

  const supabase = createClient(process.env.SUPABASE_URL, serviceKey);
  const resend = new Resend(process.env.RESEND_API_KEY);
  const metadata = { name, country, wa, whatsapp: wa };

  try {
    let result = await generateSignupLinkWithSupabaseJs({ supabase, email, password, redirectTo, metadata });
    let generateMethod = 'supabase-js';

    if (result.error && isRedirectMessage(result.error.message)) {
      console.warn('signup_generate_link_redirect_retry_no_redirect', { email: maskEmail(email), message: result.error.message });
      result = await supabase.auth.admin.generateLink({ type: 'signup', email, password, options: { data: metadata } });
      generateMethod = 'supabase-js-no-redirect';
    }

    if (result.error || !result.data?.properties?.action_link) {
      console.warn('signup_generate_link_js_failed_trying_rest', { email: maskEmail(email), message: result.error?.message || 'No action link' });
      result = await generateSignupLinkWithRest({ email, password, redirectTo, metadata, serviceKey });
      generateMethod = result.method || 'rest';
    }

    const errorMessage = result.error?.message || '';
    const actionLink = result.data?.properties?.action_link;
    const user = result.data?.user || null;

    if (result.error || !actionLink) {
      console.error('signup_generate_link_failed_final', { email: maskEmail(email), message: errorMessage || 'No action link returned' });
      if (isDuplicateUserMessage(errorMessage)) {
        return json(res, 409, {
          success: false,
          code: 'USER_ALREADY_EXISTS',
          error: 'This email is already registered. Please log in or use reset password.',
        });
      }

      return json(res, 500, {
        success: false,
        code: 'GENERATE_LINK_FAILED',
        error: `Could not create the confirmation link. Supabase said: ${errorMessage || 'No action link returned'}`,
      });
    }

    if (user?.id) {
      await supabase.from('profiles').upsert({
        id: user.id,
        name: name || email.split('@')[0],
        country: country || null,
        whatsapp: wa || null,
        subscription_plan: 'free',
        subscription_status: 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' }).catch((e) => console.warn('profile_upsert_warning', e.message));
    }

    const { error: sendError } = await resend.emails.send({
      from,
      to: email,
      subject: 'Confirm your AfroRoute account',
      html: confirmationEmailHtml({ actionLink, replyTo }),
      reply_to: replyTo,
    });

    if (sendError) {
      console.error('signup_resend_failed', { email: maskEmail(email), message: sendError.message });
      return json(res, 500, { success: false, code: 'RESEND_FAILED', error: `Could not send confirmation email. Resend said: ${sendError.message}` });
    }

    console.log('signup_confirmation_sent', { email: maskEmail(email), user_id: user?.id || null, generate_method: generateMethod });
    return json(res, 200, { success: true, confirmation_sent: true, user: user ? { id: user.id, email: user.email } : { email } });
  } catch (err) {
    console.error('signup_confirmation_unhandled', { email: maskEmail(email), message: err.message });
    return json(res, 500, { success: false, code: 'UNHANDLED', error: `Could not create account or send confirmation email. ${err.message}` });
  }
};
