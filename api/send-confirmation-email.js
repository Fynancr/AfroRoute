// api/send-confirmation-email.js
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
function maskEmail(email) { const [name, domain] = String(email || '').split('@'); return domain ? `${name.slice(0, 2)}***@${domain}` : 'invalid'; }
function normalizeSiteUrl() { return (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.afroroute.com').replace(/\/$/, ''); }
function safeRedirect(raw) { const siteUrl = normalizeSiteUrl(); try { const url = new URL(raw || `${siteUrl}/auth/callback`); const site = new URL(siteUrl); return url.host === site.host ? url.toString() : `${siteUrl}/auth/callback`; } catch (_) { return `${siteUrl}/auth/callback`; } }
function isRedirectError(msg) { const lower = String(msg || '').toLowerCase(); return lower.includes('redirect') || lower.includes('uri') || lower.includes('url') || lower.includes('not allowed'); }
function template({ actionLink, replyTo }) { return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0A2540;background:#f7f9fb"><div style="text-align:center;margin-bottom:22px"><div style="font-size:34px;margin-bottom:8px">✈️</div><h1 style="margin:0;font-size:26px;color:#0A2540">AfroRoute</h1></div><div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px"><h2 style="margin:0 0 12px;font-size:21px;color:#0A2540">Access your AfroRoute account</h2><p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 24px">Click the button below to confirm your email and continue to AfroRoute.</p><p style="margin:28px 0;text-align:center"><a href="${actionLink}" style="background:#1ABC9C;color:white;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:bold;display:inline-block">Continue to AfroRoute</a></p><p style="font-size:13px;color:#64748b">If the button does not work, copy this link:</p><p style="font-size:12px;line-height:1.6;word-break:break-all;color:#0A2540">${actionLink}</p></div><div style="text-align:center;margin-top:20px;font-size:12px;color:#94a3b8;line-height:1.7">Need help? Contact <a href="mailto:${replyTo}" style="color:#1ABC9C">${replyTo}</a><br>© 2026 AfroRoute</div></div>`; }
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const redirectTo = safeRedirect(body.redirectTo);
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const from = process.env.RESEND_FROM || 'AfroRoute <noreply@afroroute.com>';
  const replyTo = process.env.RESEND_REPLY_TO || 'support@afroroute.com';
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, error: 'Valid email is required' });
  if (!process.env.SUPABASE_URL || !serviceKey || !process.env.RESEND_API_KEY) return res.status(500).json({ success: false, error: 'Email service is not configured' });
  const supabase = createClient(process.env.SUPABASE_URL, serviceKey);
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    let { data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo } });
    if (error && isRedirectError(error.message)) { console.warn('resend_generate_link_redirect_retry', { email: maskEmail(email), message: error.message }); ({ data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email })); }
    const actionLink = data?.properties?.action_link;
    if (error || !actionLink) { console.error('resend_generate_link_failed', { email: maskEmail(email), message: error?.message || 'No link' }); return res.status(500).json({ success: false, code: 'GENERATE_LINK_FAILED', error: 'Could not create the confirmation link. Check Supabase Auth URL Configuration and service role key.' }); }
    const { error: sendError } = await resend.emails.send({ from, to: email, subject: 'Continue to AfroRoute', html: template({ actionLink, replyTo }), reply_to: replyTo });
    if (sendError) { console.error('resend_confirmation_failed', { email: maskEmail(email), message: sendError.message }); return res.status(500).json({ success: false, error: 'Could not send confirmation email' }); }
    console.log('resend_confirmation_sent', { email: maskEmail(email) });
    return res.status(200).json({ success: true });
  } catch (err) { console.error('resend_confirmation_unhandled', { email: maskEmail(email), message: err.message }); return res.status(500).json({ success: false, error: 'Could not send confirmation email' }); }
};
