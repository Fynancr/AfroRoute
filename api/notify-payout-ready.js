// api/notify-payout-ready.js
// Sends admin email when both parties confirm delivery and payout is ready.
// Do NOT auto-release payout. Admin reviews manually.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { agreement_id, shipment_id, agreement } = req.body;

  if (!agreement_id) {
    return res.status(400).json({ error: 'Missing agreement_id' });
  }

  const senderName    = agreement?.sender_name   || 'Unknown sender';
  const travelerName  = agreement?.traveler_name || 'Unknown traveler';
  const route         = agreement?.route         || (agreement?.pickup_city && agreement?.delivery_city
                          ? `${agreement.pickup_city} → ${agreement.delivery_city}` : 'Unknown route');
  const declaredValue = agreement?.declared_value != null ? `€${agreement.declared_value}` : 'Not declared';
  const agrStatus     = agreement?.agreement_status || 'delivery_confirmed';
  const now           = new Date().toISOString();

  const adminEmail  = process.env.ADMIN_EMAIL || 'alcino.manuel86@gmail.com';
  const fromEmail   = process.env.RESEND_FROM    || 'AfroRoute <noreply@afroroute.com>';
  const replyTo     = process.env.RESEND_REPLY_TO || 'support@afroroute.com';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        reply_to: replyTo,
        to: [adminEmail],
        subject: `AfroRoute payout ready — Shipment ${shipment_id || agreement_id}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <div style="background: #0A2540; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
              <div style="font-size: 22px; font-weight: 800; color: #fff;">✈️ AfroRoute Admin</div>
              <div style="font-size: 14px; color: rgba(255,255,255,.7); margin-top: 4px;">Payout ready for manual review</div>
            </div>

            <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
              <h2 style="color: #0A2540; margin: 0 0 16px; font-size: 18px;">🟢 Delivery Confirmed — Payout Ready</h2>
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600; width: 40%;">Agreement ID</td><td style="padding: 6px 0; color: #0A2540; font-weight: 700;">${agreement_id}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600;">Shipment ID</td><td style="padding: 6px 0; color: #0A2540;">${shipment_id || 'N/A'}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600;">Sender</td><td style="padding: 6px 0; color: #0A2540;">${senderName}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600;">Traveler</td><td style="padding: 6px 0; color: #0A2540;">${travelerName}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600;">Route</td><td style="padding: 6px 0; color: #0A2540;">${route}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600;">Declared Value</td><td style="padding: 6px 0; color: #0A2540; font-weight: 700;">${declaredValue}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600;">Agreement Status</td><td style="padding: 6px 0; color: #0A2540;">${agrStatus}</td></tr>
                <tr><td style="padding: 6px 0; color: #64748b; font-weight: 600;">Payout Ready At</td><td style="padding: 6px 0; color: #0A2540;">${now}</td></tr>
              </table>
            </div>

            <div style="background: #fef3c7; border: 1px solid #fde68a; border-radius: 10px; padding: 14px; margin-bottom: 16px;">
              <div style="font-weight: 700; color: #92400e; margin-bottom: 6px;">⚠ Admin action required</div>
              <ol style="margin: 0; padding-left: 18px; color: #78350f; font-size: 13px; line-height: 1.8;">
                <li>Review the shipment agreement in Supabase</li>
                <li>Review the delivery confirmation record</li>
                <li>Check for any open disputes</li>
                <li>Verify traveler payout method in user_payout_methods table</li>
                <li>Release payout manually via traveler's payout method</li>
                <li>Update <code>delivery_confirmations.payout_ready = true</code> and set shipment status to <code>payout_released</code></li>
              </ol>
            </div>

            <div style="background: #f0f4f8; border-radius: 10px; padding: 12px; font-size: 12px; color: #64748b; text-align: center;">
              Do NOT auto-release payout. Manual review is required for every payout.<br>
              AfroRoute · <a href="https://www.afroroute.com" style="color: #1ABC9C;">afroroute.com</a><br>
              Need help? Contact <a href="mailto:support@afroroute.com" style="color: #1ABC9C;">support@afroroute.com</a>
            </div>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send admin notification' });
    }

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('notify-payout-ready error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to notify admin' });
  }
};
