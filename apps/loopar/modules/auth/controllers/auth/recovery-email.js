import { loopar, getRequest, tenant } from 'loopar';

/**
 * Origin for the links: the host this request was routed on (the tenant
 * registry resolved the tenant from it), else the tenant's own domain. One
 * core serves every tenant, so there is no per-tenant DOMAIN env to read.
 */
function origin() {
  const req = getRequest();
  const host = String(req?.headers?.host || '').split(',')[0].trim();
  if (!host) return tenant.tenantUrl(loopar.tenantId);
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

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
  const resetUrl = `${origin()}/auth/recoveryPassword?token=${rawToken}`;

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
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Confirmation link for a verified email change (sent to the NEW address). */
export async function sendEmailChangeConfirmation({ user, newEmail, url }) {
  await deliverEmail({
    to: newEmail,
    subject: 'Confirm your new email address',
    html: `
      <p>Hi ${escapeHtml(user.first_name || user.name)},</p>
      <p>Confirm that <strong>${escapeHtml(newEmail)}</strong> should become the email address of your account.</p>
      <p>
        <a href="${escapeHtml(url)}" style="background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">
          Confirm new email
        </a>
      </p>
      <p>This link expires in <strong>24 hours</strong> and works once.</p>
      <p>If you didn't request this change, ignore this email — nothing will change.</p>
      <small>Or copy this link: ${escapeHtml(url)}</small>
    `,
  });
}

/**
 * Heads-up to the address that is (pending) or was (done) on the account, so
 * a takeover attempt never goes unnoticed by the real owner.
 */
export async function sendEmailChangedNotice({ to, user, newEmail, pending = false }) {
  await deliverEmail({
    to,
    subject: pending ? 'Email change requested on your account' : 'Your account email was changed',
    html: pending ? `
      <p>Hi ${escapeHtml(user.first_name || user.name)},</p>
      <p>A request was made to change the email of your account to <strong>${escapeHtml(newEmail)}</strong>.
         It only takes effect once that address confirms it.</p>
      <p>If this wasn't you, change your password right away and contact your administrator.</p>
    ` : `
      <p>Hi ${escapeHtml(user.first_name || user.name)},</p>
      <p>The email of your account is now <strong>${escapeHtml(newEmail)}</strong>; this address no longer receives its notifications or password resets.</p>
      <p>If this wasn't you, contact your administrator right away.</p>
    `,
  });
}
