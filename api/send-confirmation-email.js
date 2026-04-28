// api/send-confirmation-email.js
// Uses Supabase Admin generateLink to get official confirmation token
// then delivers it via Resend — no fake/static links

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
    return res.status(400).json({ error: 'Valid email required' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  const resend = new Resend(process.env.RESEND_API_KEY);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.afroroute.com';
  const fromEmail = process.env.RESEND_FROM || 'noreply@afroroute.com';

  try {
    // Generate official Supabase confirmation link
    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'signup',
      email: email.trim().toLowerCase(),
      options: {
        redirectTo: siteUrl,
      },
    });

    if (error || !data?.properties?.action_link) {
      console.error('generateLink error:', error?.message);
      return res.status(500).json({ error: 'Could not generate confirmation link' });
    }

    const confirmationLink = data.properties.action_link;
    console.log('Confirmation link generated for:', email, '| host:', new URL(confirmationLink).host);

    // Send via Resend
    const { error: sendError } = await resend.emails.send({
      from: `AfroRoute <${fromEmail}>`,
      to: email.trim().toLowerCase(),
      subject: 'Confirm your AfroRoute account',
      html: `
        <div style="font-family:'Helvetica Neue',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
          <div style="text-align:center;margin-bottom:24px;">
            <h1 style="color:#0A2540;font-size:24px;margin:0;">✈️ AfroRoute</h1>
          </div>
          <h2 style="color:#0A2540;font-size:20px;">Confirm your email</h2>
          <p style="color:#475569;font-size:15px;line-height:1.6;">
            Click the button below to confirm your AfroRoute account.
            This link expires in 24 hours.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${confirmationLink}"
               style="background:#1ABC9C;color:#fff;padding:14px 32px;border-radius:10px;
                      text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">
              Confirm my account
            </a>
          </div>
          <p style="color:#94a3b8;font-size:13px;">
            If you didn't create an AfroRoute account, you can safely ignore this email.
          </p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
          <p style="color:#94a3b8;font-size:12px;text-align:center;">
            AfroRoute · <a href="https://www.afroroute.com" style="color:#1ABC9C;">afroroute.com</a>
          </p>
        </div>
      `,
    });

    if (sendError) {
      console.error('Resend send error:', sendError.message);
      return res.status(500).json({ error: 'Could not send confirmation email' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-confirmation-email error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
