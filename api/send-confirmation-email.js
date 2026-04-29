// api/send-confirmation-email.js
// Sends an official Supabase magic link / confirmation continuation email through Resend.
// One job only: resend / continue email for an existing account.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    return url.host === site.host ? url.toString() : fallback;
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
  if (payload && payload.role && payload.role !== 'service_role') {
    return `SUPABASE_SERVICE_KEY is not a service_role key. Current role: ${payload.role}.`;
  }
  return null;
}

function isRedirectMessage(msg) {
  const s = String(msg || '').toLowerCase();
  return s.includes('redirect') || s.includes('uri') || s.includes('url') || s.includes('not allowed');
}

function template({ actionLink, replyTo }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0A2540;background:#f7f9fb">
      <div style="text-align:center;margin-bottom:22px">
        <div style="font-size:34px;margin-bottom:8px">✈️</div>
        <h1 style="margin:0;font-size:26px;color:#0A2540">AfroRoute</h1>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
        <h2 style="margin:0 0 12px;font-size:21px;color:#0A2540">Continue to AfroRoute</h2>
        <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 24px">
          Click the button below to continue to AfroRoute.
        </p>
        <p style="margin:28px 0;text-align:center">
          <a href="${actionLink}" style="background:#1ABC9C;color:white;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:bold;display:inline-block">Continue</a>
        </p>
        <p style="font-size:13px;color:#64748b">If the button does not work, copy this link:</p>
        <p style="font-size:12px;line-height:1.6;word-break:break-all;color:#0A2540">${actionLink}</p>
      </div>
      <div style="text-align:center;margin-top:20px;font-size:12px;color:#94a3b8;line-height:1.7">
        Need help? Contact <a href="mailto:${replyTo}" style="color:#1ABC9C">${replyTo}</a><br>© 2026 AfroRoute
      </div>
    </div>`;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (_) {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const redirectTo = safeRedirect(body.redirectTo);
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const from = process.env.RESEND_FROM || 'AfroRoute <noreply@afroroute.com>';
  const replyTo = process.env.RESEND_REPLY_TO || 'support@afroroute.com';

  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, error: 'Valid email is required' });
  if (!process.env.SUPABASE_URL || !serviceKey || !process.env.RESEND_API_KEY) {
    return res.status(500).json({ success: false, code: 'MISSING_ENV', error: 'Email service is not configured. Check Vercel env vars.' });
  }

  const keyProblem = serviceKeyProblem(serviceKey);
  if (keyProblem) return res.status(500).json({ success: false, code: 'BAD_SERVICE_KEY', error: keyProblem });

  const supabase = createClient(process.env.SUPABASE_URL, serviceKey);
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    let { data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } });
    if (error && isRedirectMessage(error.message)) {
      console.warn('resend_generate_link_redirect_retry_no_redirect', { email: maskEmail(email), message: error.message });
      ({ data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email }));
    }

    const actionLink = data?.properties?.action_link;
    if (error || !actionLink) {
      console.error('resend_generate_link_failed', { email: maskEmail(email), message: error?.message || 'No action link' });
      return res.status(500).json({ success: false, code: 'GENERATE_LINK_FAILED', error: `Could not create the confirmation link. Supabase said: ${error?.message || 'No action link returned'}` });
    }

    const { error: sendError } = await resend.emails.send({ from, to: email, subject: 'Continue to AfroRoute', html: template({ actionLink, replyTo }), reply_to: replyTo });
    if (sendError) return res.status(500).json({ success: false, code: 'RESEND_FAILED', error: `Could not send confirmation email. Resend said: ${sendError.message}` });

    console.log('resend_confirmation_sent', { email: maskEmail(email) });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('resend_confirmation_unhandled', { email: maskEmail(email), message: err.message });
    return res.status(500).json({ success: false, code: 'UNHANDLED', error: `Could not send confirmation email. ${err.message}` });
  }
};
