// api/send-confirmation-email.js
// Resend confirmation/login email for an already-created email address.
// For existing users, Supabase cannot always generate a new "signup" link, so we generate an official
// magic-link through Supabase Admin and send it with Resend. Clicking it proves email ownership and logs the user in.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return 'invalid';
  return `${name.slice(0, 2)}***@${domain}`;
}
function template({ actionLink, replyTo }) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0A2540;background:#f7f9fb">
    <div style="text-align:center;margin-bottom:22px"><div style="font-size:34px;margin-bottom:8px">✈️</div><h1 style="margin:0;font-size:26px;color:#0A2540">AfroRoute</h1></div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">
      <h2 style="margin:0 0 12px;font-size:21px;color:#0A2540">Access your AfroRoute account</h2>
      <p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 24px">Click the button below to confirm your email and continue to AfroRoute.</p>
      <p style="margin:28px 0;text-align:center"><a href="${actionLink}" style="background:#1ABC9C;color:white;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:bold;display:inline-block">Continue to AfroRoute</a></p>
      <p style="font-size:13px;color:#64748b">If the button does not work, copy this link:</p>
      <p style="font-size:12px;line-height:1.6;word-break:break-all;color:#0A2540">${actionLink}</p>
    </div>
    <div style="text-align:center;margin-top:20px;font-size:12px;color:#94a3b8;line-height:1.7">Need help? Contact <a href="mailto:${replyTo}" style="color:#1ABC9C">${replyTo}</a><br>© 2026 AfroRoute</div>
  </div>`;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email = String(body.email || '').trim().toLowerCase();
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.afroroute.com';
  const redirectTo = String(body.redirectTo || `${siteUrl}/auth/callback`);
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const from = process.env.RESEND_FROM || 'AfroRoute <noreply@afroroute.com>';
  const replyTo = process.env.RESEND_REPLY_TO || 'support@afroroute.com';

  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, error: 'Valid email is required' });
  if (!process.env.SUPABASE_URL || !serviceKey || !process.env.RESEND_API_KEY) {
    return res.status(500).json({ success: false, error: 'Email service is not configured' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, serviceKey);
  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo },
    });
    const actionLink = data?.properties?.action_link;
    if (error || !actionLink) {
      console.error('resend_generate_link_failed', { email: maskEmail(email), message: error?.message || 'No link' });
      return res.status(500).json({ success: false, error: 'Could not generate confirmation link' });
    }
    const { error: sendError } = await resend.emails.send({
      from,
      to: email,
      subject: 'Continue to AfroRoute',
      html: template({ actionLink, replyTo }),
      reply_to: replyTo,
    });
    if (sendError) {
      console.error('resend_confirmation_failed', { email: maskEmail(email), message: sendError.message });
      return res.status(500).json({ success: false, error: 'Could not send confirmation email' });
    }
    console.log('resend_confirmation_sent', { email: maskEmail(email) });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('resend_confirmation_unhandled', { email: maskEmail(email), message: err.message });
    return res.status(500).json({ success: false, error: 'Could not send confirmation email' });
  }
};
