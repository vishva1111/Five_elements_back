const https = require('https')

// ── Brevo Transactional Email API (no IP restriction, free 300/day) ───────────
// Set in backend/.env:
//   BREVO_API_KEY=xkeysib-...   (from Brevo Dashboard → Settings → SMTP & API → API Keys tab)
//   EMAIL_FROM_NAME=Five Elements
//   EMAIL_FROM_ADDRESS=devworkfe@gmail.com

function sendBrevoEmail({ toEmail, toName, subject, htmlContent }) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.BREVO_API_KEY
    if (!apiKey) {
      console.warn('[emailService] BREVO_API_KEY not set — skipping email.')
      return resolve()
    }

    const fromName    = process.env.EMAIL_FROM_NAME    || 'Five Elements'
    const fromAddress = process.env.EMAIL_FROM_ADDRESS || 'devworkfe@gmail.com'

    const body = JSON.stringify({
      sender:     { name: fromName, email: fromAddress },
      to:         [{ email: toEmail, name: toName || toEmail }],
      subject,
      htmlContent,
    })

    const options = {
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'accept':       'application/json',
        'api-key':      apiKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[emailService] Email sent to ${toEmail} — status: ${res.statusCode}`)
          resolve()
        } else {
          console.error(`[emailService] Brevo API error ${res.statusCode}:`, data)
          reject(new Error(`Brevo API ${res.statusCode}: ${data}`))
        }
      })
    })

    req.on('error', (err) => {
      console.error('[emailService] Request error:', err.message)
      reject(err)
    })

    req.write(body)
    req.end()
  })
}

// ── Send Welcome Email after Signup ──────────────────────────────────────────
async function sendWelcomeEmail({ toEmail, displayName, role }) {
  const roleLabel = {
    individual: 'Individual',
    business:   'Business',
    partner:    'Partner',
    admin:      'Admin',
  }[role] || 'Member'

  const dashboardUrl = {
    individual: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/impact`,
    business:   `${process.env.FRONTEND_URL || 'http://localhost:5173'}/business`,
    partner:    `${process.env.FRONTEND_URL || 'http://localhost:5173'}/partner`,
    admin:      `${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin`,
  }[role] || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/impact`

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Welcome to Five Elements</title>
</head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#1a6b3c 0%,#2d9e5f 100%);padding:40px 40px 30px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;font-weight:700;letter-spacing:1px;">🌿 Five Elements</h1>
              <p style="color:#a8e6c3;margin:8px 0 0;font-size:14px;">Carbon Action &amp; Reporting Marketplace</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1a6b3c;margin:0 0 16px;font-size:22px;">Welcome, ${displayName}! 🎉</h2>
              <p style="color:#444;font-size:16px;line-height:1.6;margin:0 0 20px;">
                Your <strong>${roleLabel}</strong> account has been created successfully on Five Elements — India's carbon action marketplace.
              </p>
              <p style="color:#444;font-size:16px;line-height:1.6;margin:0 0 28px;">
                You can now explore carbon projects, track your impact, and contribute to a greener future.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="background:#1a6b3c;border-radius:8px;padding:14px 32px;">
                    <a href="${dashboardUrl}" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">Go to My Dashboard →</a>
                  </td>
                </tr>
              </table>
              <hr style="border:none;border-top:1px solid #e8f0eb;margin:28px 0;" />
              <p style="color:#888;font-size:13px;line-height:1.5;margin:0;">
                If you did not create this account, please ignore this email or contact us at
                <a href="mailto:support@fiveelements.tech" style="color:#1a6b3c;">support@fiveelements.tech</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f4f7f6;padding:20px 40px;text-align:center;">
              <p style="color:#aaa;font-size:12px;margin:0;">© 2025 Five Elements. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim()

  try {
    await sendBrevoEmail({
      toEmail,
      toName:      displayName,
      subject:     `Welcome to Five Elements, ${displayName}! 🌿`,
      htmlContent,
    })
  } catch (err) {
    // Non-fatal — signup still succeeds
    console.error('[emailService] sendWelcomeEmail failed:', err.message)
  }
}

// ── Send Role Added Email ─────────────────────────────────────────────────────
async function sendRoleAddedEmail({ toEmail, displayName, newRole }) {
  const roleLabel = {
    individual: 'Individual',
    business:   'Business',
    partner:    'Partner',
  }[newRole] || newRole

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f4f7f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f6;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#1a6b3c 0%,#2d9e5f 100%);padding:40px;text-align:center;">
              <h1 style="color:#ffffff;margin:0;font-size:28px;">🌿 Five Elements</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#1a6b3c;margin:0 0 16px;">New Role Added: ${roleLabel}</h2>
              <p style="color:#444;font-size:16px;line-height:1.6;margin:0 0 20px;">
                Hi ${displayName}, your account now has <strong>${roleLabel}</strong> access on Five Elements.
              </p>
              <p style="color:#444;font-size:16px;line-height:1.6;margin:0 0 28px;">
                Log in and switch roles from your profile menu to access your new dashboard.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="background:#1a6b3c;border-radius:8px;padding:14px 32px;">
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/welcome" style="color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;">Log In Now →</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#f4f7f6;padding:20px 40px;text-align:center;">
              <p style="color:#aaa;font-size:12px;margin:0;">© 2025 Five Elements. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim()

  try {
    await sendBrevoEmail({
      toEmail,
      toName:      displayName,
      subject:     `${roleLabel} access added to your Five Elements account`,
      htmlContent,
    })
  } catch (err) {
    console.error('[emailService] sendRoleAddedEmail failed:', err.message)
  }
}

module.exports = { sendWelcomeEmail, sendRoleAddedEmail }
