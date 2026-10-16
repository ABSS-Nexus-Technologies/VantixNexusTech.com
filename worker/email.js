/**
 * Nexora Nexus — Transactional Email Delivery (Phase 33)
 *
 * Implements:
 * - Resend HTTPS API integration (https://api.resend.com/emails).
 * - Safe HTML/text template generation with strict entity escaping to prevent HTML injection.
 * - Non-sensitive logging (never logs tokens, passwords, or full verification URLs).
 * - Graceful degradation when email credentials are not configured.
 * - Fixed/validated origin resolution for verification links (no arbitrary Host header trust).
 */

const RESEND_API_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_PRODUCTION_BASE_URL = 'https://vantixnexustech-com.abssnexus.workers.dev';

/**
 * Escapes unsafe HTML characters to prevent XSS/injection in email templates.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Resolves a trusted base URL for application links.
 * Prioritizes configured APP_BASE_URL, then validates request origin, falling back to production URL.
 * @param {object} env - Worker environment bindings
 * @param {string|null} requestOrigin - Origin from incoming request
 * @returns {string}
 */
export function resolveBaseUrl(env, requestOrigin = null) {
  if (env && typeof env.APP_BASE_URL === 'string' && env.APP_BASE_URL.trim()) {
    const configured = env.APP_BASE_URL.trim().replace(/\/+$/, '');
    if (configured.startsWith('https://') || configured.startsWith('http://localhost') || configured.startsWith('http://127.0.0.1')) {
      return configured;
    }
  }

  if (requestOrigin && typeof requestOrigin === 'string') {
    const origin = requestOrigin.trim().replace(/\/+$/, '');
    if (origin.startsWith('https://') || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      return origin;
    }
  }

  return DEFAULT_PRODUCTION_BASE_URL;
}

/**
 * Generates email content for account verification.
 * @param {string} fullName - Recipient full legal name
 * @param {string} verificationUrl - Secure single-use verification URL
 * @returns {{ subject: string, html: string, text: string }}
 */
export function buildVerificationEmailContent(fullName, verificationUrl) {
  const safeName = escapeHtml(fullName || 'Applicant');
  const safeUrl = escapeHtml(verificationUrl);

  const subject = 'Verify your email address — Nexora Nexus Admissions';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 36px 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .brand { font-size: 20px; font-weight: 800; color: #0f172a; letter-spacing: -0.02em; margin-bottom: 24px; }
    .brand span { color: #2563eb; }
    h1 { font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 16px; color: #0f172a; }
    p { font-size: 15px; line-height: 1.6; color: #475569; margin: 0 0 16px; }
    .btn-wrap { margin: 28px 0; }
    .btn { display: inline-block; background-color: #0f172a; color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 24px; border-radius: 8px; }
    .footer { font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 20px; margin-top: 28px; line-height: 1.5; }
    .link-fallback { word-break: break-all; font-family: monospace; font-size: 12px; color: #64748b; background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">NEXORA <span>NEXUS</span></div>
    <h1>Verify Your Email Address</h1>
    <p>Hello ${safeName},</p>
    <p>Thank you for registering an applicant account with Nexora Nexus. Please confirm your email address to activate your account and access the admissions portal.</p>
    <div class="btn-wrap">
      <a href="${safeUrl}" class="btn" target="_blank" rel="noopener noreferrer">Verify Email Address →</a>
    </div>
    <p>Or paste this link into your browser:</p>
    <div class="link-fallback">${safeUrl}</div>
    <p style="margin-top: 20px;">This verification link will expire in 24 hours and can only be used once.</p>
    <div class="footer">
      If you did not create an account on Nexora Nexus, you can safely ignore this email.<br>
      © 2026 Nexora Nexus. All rights reserved.
    </div>
  </div>
</body>
</html>`;

  const text = `NEXORA NEXUS — ADMISSIONS

Verify Your Email Address

Hello ${fullName || 'Applicant'},

Thank you for registering an applicant account with Nexora Nexus. Please confirm your email address to activate your account and access the admissions portal:

${verificationUrl}

This verification link will expire in 24 hours and can only be used once.

If you did not create an account on Nexora Nexus, you can safely ignore this email.

© 2026 Nexora Nexus. All rights reserved.`;

  return { subject, html, text };
}

/**
 * Sends a transactional verification email via Resend API.
 * Safely fails if credentials or environment are unconfigured.
 *
 * @param {object} env - Cloudflare Worker environment bindings
 * @param {object} params
 * @param {string} params.email - Recipient email address
 * @param {string} [params.fullName] - Recipient full name
 * @param {string} params.token - 64-char raw hex verification token
 * @param {string} [params.origin] - Request origin for link building
 * @param {typeof fetch} [customFetch] - Optional fetch implementation for testing
 * @returns {Promise<{ sent: boolean, reason?: string, id?: string, status?: number }>}
 */
export async function sendVerificationEmail(env, { email, fullName, token, origin = null }, customFetch = null) {
  const fetchImpl = customFetch || fetch;

  // Verify provider configuration
  if (!env || env.EMAIL_PROVIDER !== 'resend' || !env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    // Non-sensitive operational log
    console.warn(`[Nexora Nexus Email] Resend provider not active (EMAIL_PROVIDER=${env?.EMAIL_PROVIDER || 'none'}, configured=${Boolean(env?.EMAIL_API_KEY && env?.EMAIL_FROM)}). Email dispatch skipped.`);
    return { sent: false, reason: 'unconfigured' };
  }

  const baseUrl = resolveBaseUrl(env, origin);
  const verificationUrl = `${baseUrl}/verify-email.html?token=${encodeURIComponent(token)}`;

  const { subject, html, text } = buildVerificationEmailContent(fullName, verificationUrl);

  const payload = {
    from: env.EMAIL_FROM,
    to: [email.trim().toLowerCase()],
    subject,
    html,
    text
  };

  try {
    const response = await fetchImpl(RESEND_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'NexoraNexus-Worker/1.0'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      // Safe operational log — do NOT log token or verification URL
      console.log(`[Nexora Nexus Email] Verification email dispatched successfully. ID: ${data?.id || 'unknown'}`);
      return { sent: true, id: data?.id };
    }

    const errorBody = await response.text().catch(() => '');
    let safeMessage = 'Provider rejected request';
    try {
      const parsed = JSON.parse(errorBody);
      safeMessage = parsed.message || parsed.name || safeMessage;
    } catch {
      safeMessage = errorBody.slice(0, 100);
    }

    // Safe operational error log — never log token or link
    console.error(`[Nexora Nexus Email Error] Resend HTTP ${response.status}: ${safeMessage}`);
    return { sent: false, reason: 'provider_error', status: response.status };
  } catch (err) {
    console.error('[Nexora Nexus Email Error] Network exception during email dispatch:', err instanceof Error ? err.message : 'Unknown');
    return { sent: false, reason: 'network_error' };
  }
}
