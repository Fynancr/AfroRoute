// api/signup-and-send-confirmation.js
// Single source of truth for signup + confirmation email.
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

function setCors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
function maskEmail(email) { const [name, domain] = String(email || '').split('@'); return domain ? `${name.slice(0, 2)}***@${domain}` : 'invalid'; }
function normalizeSiteUrl() { return (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.afroroute.com').replace(/\/$/, ''); }
function safeRedirect(raw) { const siteUrl = normalizeSiteUrl(); try { const url = new URL(raw || `${siteUrl}/auth/callback`); const site = new URL(siteUrl); return url.host === site.host ? url.toString() : `${siteUrl}/auth/callback`; } catch (_) { return `${siteUrl}/auth/callback`; } }
function isDuplicateUserError(msg) { const lower = String(msg || '').toLowerCase(); return lower.includes('already') || lower.includes('registered') || lower.includes('exists') || lower.includes('duplicate'); }
function isRedirectError(msg) { const lower = String(msg || '').toLowerCase(); return lower.includes('redirect') || lower.includes('uri') || lower.includes('url') || lower.includes('not allowed'); }
function htmlTemplate({ actionLink, replyTo }) { return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0A2540;background:#f7f9fb"><div style="text-align:center;margin-bottom:22px"><div style="font-size:34px;margin-bottom:8px">✈️</div><h1 style="margin:0;font-size:26px;color:#0A2540">AfroRoute</h1></div><div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px"><h2 style="margin:0 0 12px;font-size:21px;color:#0A2540">Confirm your email</h2><p style="font-size:15px;line-height:1.6;color:#334155;margin:0 0 24px">Welcome to AfroRoute. Click the button below to confirm your email and activate your account.</p><p style="margin:28px 0;text-align:center"><a href="${actionLink}" style="background:#1ABC9C;color:white;text-decoration:none;padding:14px 24px;border-radius:10px;font-weight:bold;display:inline-block">Confirm email</a></p><p style="font-size:13px;line-height:1.6;color:#64748b;margin:0 0 8px">If the button does not work, copy and paste this link into your browser:</p><p style="font-size:12px;line-height:1.6;word-break:break-all;color:#0A2540;margin:0">${actionLink}</p><p style="font-size:13px;line-height:1.6;color:#94a3b8;margin:24px 0 0">If you did not create an AfroRoute account, you can safely ignore this email.</p></div><div style="text-align:center;margin-top:20px;font-size:12px;color:#94a3b8;line-height:1.7">Need help? Contact <a href="mailto:${replyTo}" style="color:#1ABC9C">${replyTo}</a><br>© 2026 AfroRoute · <a href="https://www.afroroute.com" style="color:#1ABC9C">afroroute.com</a></div></div>`; }

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) { return res.status(400).json({ success: false, error: 'Invalid JSON body' }); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim();
  const country = String(body.country || '').trim();
  const wa = String(body.wa || body.whatsapp || '').trim();
  const redirectTo = safeRedirect(body.redirectTo);
  const from = process.env.RESEND_FROM || 'AfroRoute <noreply@afroroute.com>';
  const replyTo = process.env.RESEND_REPLY_TO || 'support@afroroute.com';
  const serviceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, error: 'Valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  console.log('signup_confirmation_request', { email: maskEmail(email), has_supabase_url: !!process.env.SUPABASE_URL, has_service_key: !!serviceKey, has_resend_key: !!process.env.RESEND_API_KEY, redirect_host: (() => { try { return new URL(redirectTo).host; } catch { return 'invalid'; } })() });
  if (!process.env.SUPABASE_URL || !serviceKey || !process.env.RESEND_API_KEY) return res.status(500).json({ success: false, error: 'Email service is not configured' });
  const supabase = createClient(process.env.SUPABASE_URL, serviceKey);
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    let { data, error } = await supabase.auth.admin.generateLink({ type: 'signup', email, password, options: { redirectTo, data: { name, country, wa, whatsapp: wa } } });
    if (error && isRedirectError(error.message)) {
      console.warn('signup_generate_link_redirect_retry', { email: maskEmail(email), message: error.message });
      ({ data, error } = await supabase.auth.admin.generateLink({ type: 'signup', email, password, options: { data: { name, country, wa, whatsapp: wa } } }));
    }
    const actionLink = data?.properties?.action_link;
    const user = data?.user || null;
    if (error || !actionLink) {
      const msg = error?.message || 'No action link returned';
      console.error('signup_generate_link_failed', { email: maskEmail(email), message: msg });
      if (isDuplicateUserError(msg)) return res.status(409).json({ success: false, code: 'USER_ALREADY_EXISTS', error: 'This email is already registered. Please log in or use reset password.' });
      return res.status(500).json({ success: false, code: 'GENERATE_LINK_FAILED', error: 'Could not create the confirmation link. Check Supabase Auth URL Configuration and service role key.' });
    }
    if (user?.id) await supabase.from('profiles').upsert({ id: user.id, name: name || email.split('@')[0], country: country || null, whatsapp: wa || null, subscription_plan: 'free', subscription_status: 'active', updated_at: new Date().toISOString() }, { onConflict: 'id' }).catch((e) => console.warn('profile_upsert_warning', e.message));
    const { error: sendError } = await resend.emails.send({ from, to: email, subject: 'Confirm your AfroRoute account', html: htmlTemplate({ actionLink, replyTo }), reply_to: replyTo });
    if (sendError) { console.error('signup_resend_failed', { email: maskEmail(email), message: sendError.message }); return res.status(500).json({ success: false, error: 'Could not send confirmation email' }); }
    console.log('signup_confirmation_sent', { email: maskEmail(email), user_id: user?.id || null });
    return res.status(200).json({ success: true, confirmation_sent: true, user: user ? { id: user.id, email: user.email } : { email } });
  } catch (err) { console.error('signup_confirmation_unhandled', { email: maskEmail(email), message: err.message }); return res.status(500).json({ success: false, error: 'Could not create account or send confirmation email' }); }
};
