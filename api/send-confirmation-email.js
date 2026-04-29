// api/send-confirmation-email.js
// Generates official Supabase confirmation links server-side and sends them via Resend.
// Used for signup confirmation and resend confirmation flows.

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
    });
  }

  const { email } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({
      success: false,
      error: 'Valid email required',
    });
  }

  const cleanEmail = email.trim().toLowerCase();
  const emailDomain = cleanEmail.split('@')[1] || '?';

  const hasResendKey = !!process.env.RESEND_API_KEY;
  const hasServiceKey = !!process.env.SUPABASE_SERVICE_KEY;
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;

  console.log('send-confirmation-email called', {
    email_domain: emailDomain,
    has_resend_key: hasResendKey,
    has_service_key: hasServiceKey,
    has_supabase_url: hasSupabaseUrl,
  });

  if (!hasResendKey || !hasServiceKey || !hasSupabaseUrl) {
    console.error('Missing required env vars for confirmation email');
    return res.status(500).json({
      success: false,
      error: 'Server configuration error',
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const resend = new Resend(process.env.RESEND_API_KEY);

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    'https://www.afroroute.com';

  const from =
    process.env.RESEND_FROM ||
    'AfroRoute <noreply@afroroute.com>';

  const replyTo =
    process.env.RESEND_REPLY_TO ||
    'support@afroroute.com';

  try {
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'signup',
      email: cleanEmail,
      options: {
        redirectTo: `${siteUrl}/auth/callback`,
      },
    });

    const confirmationLink = data?.properties?.action_link;

    if (error || !confirmationLink) {
      console.error('generateLink failed', {
        message: error?.message || 'No action_link returned',
      });

      return res.status(500).json({
        success: false,
        error: 'Could not generate confirmation link',
      });
    }

    console.log('generateLink success', {
      link_host: new URL(confirmationLink).host,
      email_domain: emailDomain,
    });

    const { error: sendError } = await resend.emails.send({
      from,
      replyTo,
      to: cleanEmail,
      subject: 'Confirm your AfroRoute account',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #f7f9fb;">
          <div style="text-align: center; margin-bottom: 24px;">
            <div style="font-size: 34px; margin-bottom: 8px;">✈️</div>
            <h1 style="color: #0A2540; font-size: 24px; margin: 0;">AfroRoute</h1>
          </div>

          <div style="background: #ffffff; border-radius: 16px; padding: 30px; border: 1px solid #e2e8f0;">
            <h2 style="color: #0A2540; font-size: 20px; margin: 0 0 12px;">
              Confirm your email
            </h2>

            <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
              Click the button below to confirm your AfroRoute account.
              This link is generated securely by Supabase and may expire.
            </p>

            <div style="text-align: center; margin-bottom: 24px;">
              <a href="${confirmationLink}"
                 style="background: #1ABC9C; color: #ffffff; padding: 14px 34px; border-radius: 10px;
                        text-decoration: none; font-weight: 700; font-size: 16px; display: inline-block;">
                Confirm my account
              </a>
            </div>

            <p style="color: #64748b; font-size: 13px; line-height: 1.6; margin: 0 0 10px;">
              If the button does not work, copy and paste this link into your browser:
            </p>

            <p style="word-break: break-all; color: #1ABC9C; font-size: 12px; line-height: 1.6; margin: 0;">
              ${confirmationLink}
            </p>

            <p style="color: #94a3b8; font-size: 13px; line-height: 1.6; margin: 24px 0 0;">
              If you did not create an AfroRoute account, you can safely ignore this email.
            </p>
          </div>

          <div style="text-align: center; margin-top: 22px; font-size: 12px; color: #94a3b8; line-height: 1.7;">
            Need help? Contact
            <a href="mailto:${replyTo}" style="color: #1ABC9C;">${replyTo}</a><br>
            © 2026 AfroRoute ·
            <a href="https://www.afroroute.com" style="color: #1ABC9C;">afroroute.com</a>
          </div>
        </div>
      `,
    });

    if (sendError) {
      console.error('Resend send failed', {
        message: sendError.message,
        email_domain: emailDomain,
      });

      return res.status(500).json({
        success: false,
        error: 'Could not send confirmation email',
      });
    }

    console.log('Confirmation email sent successfully', {
      email_domain: emailDomain,
    });

    return res.status(200).json({
      success: true,
    });
  } catch (err) {
    console.error('send-confirmation-email error', {
      message: err.message,
      email_domain: emailDomain,
    });

    return res.status(500).json({
      success: false,
      error: 'Internal error',
    });
  }
};
