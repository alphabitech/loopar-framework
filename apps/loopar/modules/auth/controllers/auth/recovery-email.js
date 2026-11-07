import { loopar } from 'loopar';

const APP_URL = process.env.DOMAIN || 'localhost:3000';

/**
 * Deliver a transactional email with a cloud fallback.
 *
 *   - If the tenant has its own SMTP configured (Email Settings.host), use it.
 *   - Else, if this is a cloud-provisioned tenant (CLOUD_VERIFIER_URL +
 *     CLOUD_VERIFIER_TOKEN present in its env), relay through the control
 *     plane's Cloud Mail gateway so the customer can still receive recovery
 *     emails before they've configured their own SMTP.
 *   - Else, throw — there's no transport.
 *
 * The gateway endpoint is derived from CLOUD_VERIFIER_URL's origin, so we
 * don't need a separate env var for it.
 */
async function deliverEmail({ to, subject, html }) {
  let hasLocalSmtp = false;
  try {
    // Email Settings, or the Email Account of the website serving this request.
    hasLocalSmtp = await loopar.mail.hasTransport();
  } catch (_) { /* no settings doc → treat as not configured */ }

  if (hasLocalSmtp) {
    return loopar.mail.send({ to, subject, html });
  }

  const { url: verifierUrl, token: verifierToken } = loopar.cloudVerifier;
  if (verifierUrl && verifierToken) {
    let gatewayUrl;
    try {
      gatewayUrl = `${new URL(verifierUrl).origin}/api/cloud-mail/send`;
    } catch (_) {
      throw new Error('Invalid CLOUD_VERIFIER_URL — cannot derive mail gateway');
    }

    const r = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Loopar-Tenant-Secret': verifierToken,
      },
      body: JSON.stringify({
        tenant_name: loopar.tenantId,
        to, subject, html,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!data?.success) {
      throw new Error(`Cloud Mail gateway failed: ${data?.reason || r.status}`);
    }
    return data;
  }

  throw new Error('No email transport configured (no Email Settings and not a cloud tenant)');
}

export async function sendPasswordResetEmail(user, rawToken) {
  // Use the tenant's real scheme/host. In dev this is http://<tenant>.localhost:port;
  // in prod, https. DOMAIN already carries the host; default to https unless
  // it's a .localhost dev host.
  const isLocal = APP_URL.includes('localhost');
  const scheme  = isLocal ? 'http' : 'https';
  const port    = isLocal && process.env.PORT ? `:${process.env.PORT}` : '';
  const host    = APP_URL.includes(':') ? APP_URL : `${APP_URL}${port}`;
  const resetUrl = `${scheme}://${host}/auth/recoveryPassword?token=${rawToken}`;

  await deliverEmail({
    to: user.email,
    subject: 'Reset your password — Loopar',
    html: `
      <p>Hi ${user.full_name || user.name},</p>
      <p>We received a request to reset your password.</p>
      <p>
        <a href="${resetUrl}" style="background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">
          Reset password
        </a>
      </p>
      <p>This link expires in <strong>30 minutes</strong>.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
      <small>Or copy this link: ${resetUrl}</small>
    `,
  });
}

export async function sendUsernameReminderEmail(user) {
  await deliverEmail({
    to: user.email,
    subject: 'Your username — Loopar',
    html: `
      <p>Hi,</p>
      <p>Your Loopar username is:</p>
      <p style="font-size:1.4rem;font-weight:bold;letter-spacing:0.05em">${user.name}</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}