const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'AfroRoute <noreply@afroroute.com>';
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || 'support@afroroute.com';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || 'https://www.afroroute.com';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return 'invalid';
  return `${name.slice(0, 2)}***@${domain}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { success: false, error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const email = String(body.email || '').trim().toLowerCase();
    const redirectTo = String(body.redirectTo || `${SITE_URL}/auth/callback`);

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return json(res, 400, { success: false, error: 'Valid email is required' });
    }

    console.log('confirmation_email_request', {
      email: maskEmail(email),
      has_supabase_url: !!SUPABASE_URL,
      has_service_key: !!SUPABASE_SERVICE_KEY,
      has_resend_key: !!RESEND_API_KEY,
      redirect_host: (() => { try { return new URL(redirectTo).host; } catch { return 'invalid'; } })(),
    });

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY) {
      return json(res, 500, { success: false, error: 'Email service is not configured' });
    }

    const genResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
      body: JSON.stringify({
        type: 'signup',
        email,
        options: { redirect_to: redirectTo },
      }),
    });

    const genData = await genResp.json().catch(() => ({}));
    const actionLink = genData.action_link || genData.properties?.action_link || genData.link;

    if (!genResp.ok || !actionLink) {
      console.error('confirmation_generate_link_failed', {
        email: maskEmail(email),
        status: genResp.status,
        error: genData.error || genData.msg || genData.message || 'No action link returned',
      });
      return json(res, 500, { success: false, error: 'Could not generate confirmation link' });
    }

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0A2540">
        <h1 style="margin:0 0 12px;font-size:26px">Confirm your AfroRoute email</h1>
        <p style="font-size:16px;line-height:1.6;color:#334155">Welcome to AfroRoute. Confirm your email to activate your account.</p>
        <p style="margin:28px 0">
          <a href="${actionLink}" style="background:#1ABC9C;color:white;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:bold;display:inline-block">Confirm email</a>
        </p>
        <p style="font-size:13px;line-height:1.6;color:#64748b">If the button does not work, copy and paste this link into your browser:</p>
        <p style="font-size:13px;line-height:1.6;word-break:break-all;color:#0A2540">${actionLink}</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
        <p style="font-size:13px;color:#64748b">Need help? Contact <a href="mailto:support@afroroute.com" style="color:#1ABC9C">support@afroroute.com</a></p>
        <p style="font-size:12px;color:#94a3b8">© 2026 AfroRoute</p>
      </div>`;

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: email,
        subject: 'Confirm your AfroRoute email',
        html,
        reply_to: RESEND_REPLY_TO,
      }),
    });

    const resendData = await resendResp.json().catch(() => ({}));
    if (!resendResp.ok) {
      console.error('confirmation_resend_failed', {
        email: maskEmail(email),
        status: resendResp.status,
        error: resendData.message || resendData.error || 'Resend failed',
      });
      return json(res, 500, { success: false, error: 'Could not send confirmation email' });
    }

    console.log('confirmation_email_sent', { email: maskEmail(email), resend_id: resendData.id || null });
    return json(res, 200, { success: true });
  } catch (err) {
    console.error('confirmation_email_unhandled', { message: err.message });
    return json(res, 500, { success: false, error: 'Could not send confirmation email' });
  }
};
