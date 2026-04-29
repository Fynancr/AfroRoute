// api/send-confirmation-email.js
// Generates official Supabase confirmation link server-side and sends via Resend.
// Used only as a fallback/resend path — Supabase native email handles initial signup.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ success: false, error: 'Valid email required' });
  }

  const hasResendKey   = !!process.env.RESEND_API_KEY;
  const hasServiceKey  = !!process.env.SUPABASE_SERVICE_KEY;
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const emailDomain    = email.split('@')[1] || '?';

  console.log('send-confirmation-email called', {
    email_domain: emailDomain,
    has_resend_key: hasResendKey,
    has_service_key: hasServiceKey,
    has_supabase_url: hasSupabaseUrl,
  });

  if (!hasResendKey || !hasServiceKey || !hasSupabaseUrl) {
    console.error('Missing required env vars');
    return res.status(500).json({ success: false, error: 'Server configuration error' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const resend   = new Resend(process.env.RESEND_API_KEY);
  const siteUrl  = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.afroroute.com';
  const from     = process.env.RESEND_FROM     || 'AfroRoute <noreply@afroroute.com>';
  const replyTo  = process.env.RESEND_REPLY_TO || 'support@afroroute.com';

  try {
    // Generate official Supabase confirmation link (server-side only)
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'signup',
      email: email.trim().toLowerCase(),
      options: {
        redirectTo: `${siteUrl}/?verify=1`,
      },
    });

    if (error || !data?.properties?.action_link) {
      console.error('generateLink failed:', error?.message || 'no action_link');
      return res.status(500).json({ success: false, error: 'Could not generate confirmation link' });
    }

    const confirmationLink = data.properties.action_link;
    console.log('generateLink success — link host:', new URL(confirmationLink).host);

    // Send via Resend
    const { error: sendError } = await resend.emails.send({
      from,
      replyTo,
      to: email.trim().toLowerCase(),
      subject: 'Confirm your AfroRoute account',
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#f7f9fb;">
          <div style="text-align:center;margin-bottom:24px;">
            <span style="font-size:32px;">✈️</span>
            <h1 style="color:#0A2540;font-size:22px;margin:8px 0 0;">AfroRoute</h1>
          </div>
          <div style="background:#fff;border-radius:14px;padding:28px;border:1px solid #e2e8f0;">
            <h2 style="color:#0A2540;font-size:18px;margin:0 0 12px;">Confirm your email</h2>
            <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px;">
              Click the button below to confirm your AfroRoute account.
              This link expires in 24 hours.
            </p>
            <div style="text-align:center;margin-bottom:24px;">
              <a href="${confirmationLink}"
                 style="background:#1ABC9C;color:#fff;padding:14px 36px;border-radius:10px;
                        text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">
                Confirm my account
              </a>
            </div>
            <p style="color:#94a3b8;font-size:13px;margin:0;">
              If you didn't create an AfroRoute account, you can safely ignore this email.
            </p>
          </div>
          <div style="text-align:center;margin-top:20px;font-size:12px;color:#94a3b8;">
            Need help? Contact
            <a href="mailto:support@afroroute.com" style="color:#1ABC9C;">support@afroroute.com</a><br>
            <a href="https://www.afroroute.com" style="color:#1ABC9C;">afroroute.com</a>
          </div>
        </div>
      `,
    });

    if (sendError) {
      console.error('Resend send failed:', sendError.message);
      return res.status(500).json({ success: false, error: 'Could not send confirmation email' });
    }

    console.log('Confirmation email sent successfully to domain:', emailDomain);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-confirmation-email error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
};
