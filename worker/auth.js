/**
 * Nexora Nexus — Hardened Authentication & Authorization Core (Phase 23)
 *
 * Implements:
 * - Applicant registration with atomic transactions (db.batch) and pending_verification status
 * - Password length enforcement (8 to 128 chars) to mitigate hashing DoS
 * - Login with timing-safe verification, brute-force throttling, and session rotation
 * - Comprehensive password reset flow with secure single-use tokens and full session revocation
 * - Session revocation on logout and password reset
 * - Authenticated user retrieval (GET /api/user/me) strictly scoped to session user
 * - Server-side role authorization guards
 * - Multi-layer CSRF verification (Origin, Sec-Fetch-Site, Sec-Fetch-Mode, custom headers)
 * - Safe error envelopes (no credential or stack trace leakage)
 */

import {
  hashPassword,
  verifyPassword,
  performDummyPasswordCheck,
  generateSecureToken,
  hashToken,
  generateUuid,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH
} from './crypto.js';
import { sendVerificationEmail } from './email.js';

// Standard email validation pattern
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Session duration: 7 days in milliseconds
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Password reset token duration: 1 hour in milliseconds
const RESET_TOKEN_DURATION_MS = 60 * 60 * 1000;

// Email verification token duration: 24 hours in milliseconds
const VERIFICATION_TOKEN_DURATION_MS = 24 * 60 * 60 * 1000;

// Maximum failed login attempts within 15 minutes before throttling
const MAX_FAILED_LOGINS = 5;
const THROTTLE_WINDOW_MINUTES = '-15 minutes';

/**
 * Extracts a cookie value by name from request headers.
 * @param {Request} request
 * @param {string} cookieName
 * @returns {string|null}
 */
export function getCookie(request, cookieName) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Builds a secure __Host- session cookie header value.
 * @param {string} token
 * @param {number} maxAgeSeconds
 * @returns {string}
 */
export function buildSessionCookie(token, maxAgeSeconds = 604800) {
  if (!token) {
    // Clear cookie
    return `__Host-nexora_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
  return `__Host-nexora_session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

/**
 * Extracts session token from either Cookie or Authorization header.
 * @param {Request} request
 * @returns {string|null}
 */
export function extractSessionToken(request) {
  const cookieToken = getCookie(request, '__Host-nexora_session');
  if (cookieToken) return cookieToken;

  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return null;
}

/**
 * Verifies CSRF safety on state-changing requests.
 * @param {Request} request
 * @param {URL} url
 * @param {boolean} isCookieAuthenticated
 * @returns {boolean}
 */
export function verifyCsrfSafety(request, url, isCookieAuthenticated) {
  const method = request.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return true;
  }

  // Check Sec-Fetch-Mode: reject navigation requests on mutating API endpoints
  const secFetchMode = request.headers.get('Sec-Fetch-Mode');
  if (secFetchMode === 'navigate') {
    return false;
  }

  // Check Sec-Fetch-Site: reject cross-site requests
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite === 'cross-site') {
    return false;
  }

  // Check Origin: must match url.origin exactly if present
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin !== url.origin) {
      return false;
    }
  }

  // If request uses cookie authentication, require custom header X-CSRF-Token or X-Requested-With
  if (isCookieAuthenticated) {
    const csrfToken = request.headers.get('X-CSRF-Token');
    const requestedWith = request.headers.get('X-Requested-With');
    if (!csrfToken && !requestedWith) {
      return false;
    }
  }

  return true;
}

/**
 * Checks if an email/IP is currently throttled due to excessive failed logins.
 * @param {object} db
 * @param {string} email
 * @param {string} ip
 * @returns {Promise<boolean>}
 */
async function isLoginThrottled(db, email, ip) {
  try {
    let user = null;
    try {
      user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    } catch {
      // Ignore lookup error
    }
    const userId = user ? user.id : email;
    const ipStr = (ip && typeof ip === 'string' && ip.trim()) ? ip.trim() : null;

    let stmt;
    if (ipStr) {
      stmt = db.prepare(`
        SELECT COUNT(*) as failures
        FROM audit_events
        WHERE action = 'auth.login_failure'
          AND (target_id = ? OR target_id = ? OR ip_address = ?)
          AND created_at > datetime('now', '${THROTTLE_WINDOW_MINUTES}')
      `).bind(email, userId, ipStr);
    } else {
      stmt = db.prepare(`
        SELECT COUNT(*) as failures
        FROM audit_events
        WHERE action = 'auth.login_failure'
          AND (target_id = ? OR target_id = ?)
          AND created_at > datetime('now', '${THROTTLE_WINDOW_MINUTES}')
      `).bind(email, userId);
    }

    const row = await stmt.first();
    return row && Number(row.failures) >= MAX_FAILED_LOGINS;
  } catch {
    return false;
  }
}

/**
 * Logs an audit event into audit_events using parameterized query.
 * @param {object} db
 * @param {object} event
 */
export async function recordAuditEvent(db, { actorId = null, action, targetType, targetId, ip = null, userAgent = null, metadata = null }) {
  try {
    const id = `aud_${generateUuid()}`;
    const metaStr = metadata ? JSON.stringify(metadata) : null;
    await db.prepare(`
      INSERT INTO audit_events (id, actor_id, action, target_type, target_id, ip_address, user_agent, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, actorId, action, targetType, targetId, ip, userAgent, metaStr).run();
  } catch (err) {
    console.error('[Audit Log Error]', err instanceof Error ? err.message : 'Unknown');
  }
}

/**
 * Validates password complexity and length bounds.
 * @param {string} password
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { ok: false, code: 'PASSWORD_REQUIRED', message: 'Password is required' };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'WEAK_PASSWORD',
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'PASSWORD_TOO_LONG',
      message: `Password cannot exceed ${MAX_PASSWORD_LENGTH} characters`
    };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return {
      ok: false,
      code: 'WEAK_PASSWORD',
      message: 'Password must contain uppercase, lowercase, and numeric characters'
    };
  }
  return { ok: true };
}

/**
 * Registers a new intern applicant.
 * Creates account in 'pending_verification' status to prevent unverified activation.
 * Executes user and profile creation atomically via db.batch().
 */
export async function registerApplicant(db, body, ip, userAgent, env = null, options = {}) {
  const { email, password, full_name, phone, college, graduation_year, linkedin_url, github_url, portfolio_url, role } = body || {};

  // Reject explicit requests for privileged roles
  if (role && role !== 'intern') {
    return {
      status: 400,
      data: { error: { code: 'INVALID_ROLE', message: 'Public registration is only permitted for intern applicants' } }
    };
  }

  // Validate email
  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    return {
      status: 400,
      data: { error: { code: 'INVALID_EMAIL', message: 'A valid email address is required' } }
    };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Validate full name
  if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 2) {
    return {
      status: 400,
      data: { error: { code: 'INVALID_NAME', message: 'Full name must be at least 2 characters' } }
    };
  }

  // Validate password bounds and complexity
  const passCheck = validatePassword(password);
  if (!passCheck.ok) {
    return {
      status: 400,
      data: { error: { code: passCheck.code, message: passCheck.message } }
    };
  }

  // Check for existing user
  const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(normalizedEmail).first();
  if (existingUser) {
    return {
      status: 409,
      data: { error: { code: 'EMAIL_EXISTS', message: 'An account with this email address already exists' } }
    };
  }

  // Hash password with Web Crypto PBKDF2
  const { hash, salt } = await hashPassword(password);
  const userId = `usr_${generateUuid()}`;
  const profileId = `prof_${generateUuid()}`;
  const auditId = `aud_${generateUuid()}`;

  // Account is created in 'pending_verification' status
  const userStmt = db.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role, status)
    VALUES (?, ?, ?, ?, 'intern', 'pending_verification')
  `).bind(userId, normalizedEmail, hash, salt);

  const profileStmt = db.prepare(`
    INSERT INTO intern_profiles (id, user_id, full_name, phone, college, graduation_year, linkedin_url, github_url, portfolio_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    profileId,
    userId,
    full_name.trim(),
    phone ? String(phone).trim() : null,
    college ? String(college).trim() : null,
    graduation_year ? parseInt(graduation_year, 10) : null,
    linkedin_url ? String(linkedin_url).trim() : null,
    github_url ? String(github_url).trim() : null,
    portfolio_url ? String(portfolio_url).trim() : null
  );

  const auditStmt = db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, target_type, target_id, ip_address, user_agent, metadata_json)
    VALUES (?, ?, 'user.registered', 'user', ?, ?, ?, ?)
  `).bind(auditId, userId, userId, ip, userAgent, JSON.stringify({ status: 'pending_verification' }));

  // Check if email_verifications table exists (for forward-compatibility and legacy test suites)
  let hasVerificationsTable = false;
  try {
    const tblCheck = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_verifications'").first();
    hasVerificationsTable = Boolean(tblCheck);
  } catch {
    hasVerificationsTable = false;
  }

  let verificationToken = null;
  const batchStatements = [userStmt, profileStmt];

  if (hasVerificationsTable) {
    verificationToken = generateSecureToken(32);
    const tokenHash = await hashToken(verificationToken);
    const verificationId = `vtok_${generateUuid()}`;
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_DURATION_MS).toISOString();

    const verificationStmt = db.prepare(`
      INSERT INTO email_verifications (id, user_id, token_hash, expires_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(verificationId, userId, tokenHash, expiresAt, ip, userAgent);

    batchStatements.push(verificationStmt);
  }

  batchStatements.push(auditStmt);

  // Execute atomically
  if (typeof db.batch === 'function') {
    await db.batch(batchStatements);
  } else {
    for (const stmt of batchStatements) {
      await stmt.run();
    }
  }

  // Attempt email delivery if env/provider configured
  let sendResult = null;
  const isTestEnv = (env && env.ENVIRONMENT === 'test') || Boolean(options && options.isTestEnv);

  if (hasVerificationsTable && verificationToken) {
    sendResult = await sendVerificationEmail(
      env,
      {
        email: normalizedEmail,
        fullName: full_name.trim(),
        token: verificationToken,
        origin: options?.origin || null
      },
      options?.customFetch || null
    );
  }

  const emailSent = Boolean(sendResult && sendResult.sent);
  const message = emailSent
    ? 'Account created. A verification link has been sent to your email address.'
    : 'Account created. Account status is pending email verification.';

  const responseData = {
    success: true,
    message,
    email_sent: emailSent,
    user: {
      id: userId,
      email: normalizedEmail,
      role: 'intern',
      status: 'pending_verification'
    }
  };

  if (isTestEnv && verificationToken) {
    responseData._test_verification_token = verificationToken;
  }

  return {
    status: 201,
    data: responseData
  };
}

/**
 * Authenticates a user, rotates any existing session, and creates a fresh secure session.
 */
export async function loginUser(db, body, ip, userAgent, incomingSessionToken = null) {
  const { email, password } = body || {};

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return {
      status: 400,
      data: { error: { code: 'INVALID_CREDENTIALS', message: 'Email and password are required' } }
    };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check login throttling
  if (await isLoginThrottled(db, normalizedEmail, ip)) {
    return {
      status: 429,
      data: {
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many failed login attempts. Please try again in 15 minutes.'
        }
      }
    };
  }

  // Lookup user
  const user = await db.prepare(`
    SELECT id, email, password_hash, password_salt, role, status
    FROM users
    WHERE email = ?
  `).bind(normalizedEmail).first();

  if (!user) {
    // Equalize timing via dummy PBKDF2 calculation
    await performDummyPasswordCheck(password);

    await recordAuditEvent(db, {
      action: 'auth.login_failure',
      targetType: 'user',
      targetId: normalizedEmail,
      ip,
      userAgent,
      metadata: { reason: 'user_not_found' }
    });

    return {
      status: 401,
      data: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }
    };
  }

  // Verify password in constant time
  const isValid = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!isValid) {
    await recordAuditEvent(db, {
      actorId: user.id,
      action: 'auth.login_failure',
      targetType: 'user',
      targetId: user.id,
      ip,
      userAgent,
      metadata: { reason: 'incorrect_password' }
    });

    return {
      status: 401,
      data: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }
    };
  }

  // Explicit status check: unverified users cannot login
  if (user.status === 'pending_verification') {
    return {
      status: 403,
      data: {
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Account is pending email verification. Email verification service is currently awaiting provider configuration.'
        }
      }
    };
  }

  if (user.status !== 'active') {
    return {
      status: 403,
      data: { error: { code: 'ACCOUNT_INACTIVE', message: `Account is ${user.status}` } }
    };
  }

  // Session rotation: if an existing session token was provided, revoke it immediately
  if (incomingSessionToken) {
    try {
      const oldTokenHash = await hashToken(incomingSessionToken);
      await db.prepare(`
        UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE token_hash = ? AND revoked_at IS NULL
      `).bind(oldTokenHash).run();
    } catch {
      // Ignore rotation lookup failure
    }
  }

  // Generate 256-bit secure session token and hash for DB storage
  const sessionToken = generateSecureToken(32);
  const tokenHash = await hashToken(sessionToken);
  const sessionId = `sess_${generateUuid()}`;
  const csrfToken = generateSecureToken(24);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  // Save hashed token in DB
  await db.prepare(`
    INSERT INTO user_sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(sessionId, user.id, tokenHash, expiresAt, ip, userAgent).run();

  // Log successful login
  await recordAuditEvent(db, {
    actorId: user.id,
    action: 'auth.login_success',
    targetType: 'user',
    targetId: user.id,
    ip,
    userAgent
  });

  return {
    status: 200,
    sessionToken,
    data: {
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status
      },
      csrf_token: csrfToken
    }
  };
}

/**
 * Revokes a session upon logout.
 */
export async function logoutUser(db, request, ip, userAgent) {
  const token = extractSessionToken(request);
  if (token) {
    const tokenHash = await hashToken(token);
    const session = await db.prepare(`
      SELECT id, user_id FROM user_sessions WHERE token_hash = ? AND revoked_at IS NULL
    `).bind(tokenHash).first();

    if (session) {
      await db.prepare(`
        UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind(session.id).run();

      await recordAuditEvent(db, {
        actorId: session.user_id,
        action: 'auth.logout',
        targetType: 'session',
        targetId: session.id,
        ip,
        userAgent
      });
    }
  }

  return {
    status: 200,
    data: { success: true, message: 'Logged out successfully' }
  };
}

/**
 * Authenticates an incoming request using session token.
 * Returns { user, session } or null.
 */
export async function authenticateRequest(db, request) {
  const token = extractSessionToken(request);
  if (!token) return null;

  const tokenHash = await hashToken(token);

  const row = await db.prepare(`
    SELECT
      s.id as session_id,
      s.user_id,
      s.expires_at,
      s.revoked_at,
      u.id as user_id,
      u.email,
      u.role,
      u.status
    FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(tokenHash).first();

  if (!row) return null;

  return {
    user: {
      id: row.user_id,
      email: row.email,
      role: row.role,
      status: row.status
    },
    session: {
      id: row.session_id,
      expiresAt: row.expires_at
    }
  };
}

/**
 * Retrieves the full profile of the currently authenticated user.
 * Strictly scoped to the authenticated user ID.
 */
export async function getCurrentUserProfile(db, user) {
  const profile = await db.prepare(`
    SELECT
      u.id,
      u.email,
      u.role,
      u.status,
      u.created_at,
      p.full_name,
      p.phone,
      p.college,
      graduation_year,
      p.linkedin_url,
      p.github_url,
      p.portfolio_url
    FROM users u
    LEFT JOIN intern_profiles p ON u.id = p.user_id
    WHERE u.id = ?
  `).bind(user.id).first();

  if (!profile) {
    return {
      status: 404,
      data: { error: { code: 'PROFILE_NOT_FOUND', message: 'User profile not found' } }
    };
  }

  return {
    status: 200,
    data: {
      success: true,
      user: profile
    }
  };
}

/**
 * Initiates a password reset request.
 * If email service is not configured and not in test mode, returns honest 503 instead of fake-success.
 */
export async function requestPasswordReset(db, body, ip, userAgent, isEmailServiceAvailable = false, isTestEnv = false) {
  const { email } = body || {};

  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    return {
      status: 400,
      data: { error: { code: 'INVALID_EMAIL', message: 'A valid email address is required' } }
    };
  }

  // If email service is unavailable and not running in test mode, be completely honest
  if (!isEmailServiceAvailable && !isTestEnv) {
    return {
      status: 503,
      data: {
        error: {
          code: 'EMAIL_SERVICE_NOT_CONFIGURED',
          message: 'Password reset via email is currently unavailable because transactional email delivery has not been configured. Please contact support or an administrator.'
        }
      }
    };
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = await db.prepare('SELECT id, status FROM users WHERE email = ?').bind(normalizedEmail).first();

  // Rate-limit password reset requests: max 3 requests per 15 minutes
  try {
    const rateRow = await db.prepare(`
      SELECT COUNT(*) as cnt
      FROM audit_events
      WHERE action = 'auth.password_reset_requested'
        AND (target_id = ? OR (ip_address = ? AND ip_address IS NOT NULL AND ip_address != ''))
        AND created_at > datetime('now', '-15 minutes')
    `).bind(user ? user.id : normalizedEmail, (ip && ip.trim()) || '').first();

    if (rateRow && Number(rateRow.cnt) >= 3) {
      return {
        status: 429,
        data: {
          error: {
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many password reset requests. Please try again in 15 minutes.'
          }
        }
      };
    }
  } catch {
    // Suppress query error
  }

  if (!user || user.status !== 'active') {
    await recordAuditEvent(db, {
      action: 'auth.password_reset_requested',
      targetType: 'user',
      targetId: normalizedEmail,
      ip,
      userAgent
    });
    // Equalize timing via dummy calculation
    await performDummyPasswordCheck('DummyPassword123!');
    return {
      status: 200,
      data: {
        success: true,
        message: 'If an account exists with that email address, password reset instructions have been issued.'
      }
    };
  }

  // Invalidate any pre-existing active reset tokens for this user
  await db.prepare(`
    UPDATE password_resets
    SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND used_at IS NULL
  `).bind(user.id).run();

  // Generate secure reset token
  const resetToken = generateSecureToken(32);
  const tokenHash = await hashToken(resetToken);
  const resetId = `rst_${generateUuid()}`;
  const expiresAt = new Date(Date.now() + RESET_TOKEN_DURATION_MS).toISOString();

  await db.prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, expires_at, ip_address)
    VALUES (?, ?, ?, ?, ?)
  `).bind(resetId, user.id, tokenHash, expiresAt, ip).run();

  await recordAuditEvent(db, {
    actorId: user.id,
    action: 'auth.password_reset_requested',
    targetType: 'user',
    targetId: user.id,
    ip,
    userAgent
  });

  const responseData = {
    success: true,
    message: 'If an account exists with that email address, password reset instructions have been issued.'
  };

  // In test environment, expose the reset token to test the complete end-to-end flow
  if (isTestEnv) {
    responseData._test_reset_token = resetToken;
  }

  return {
    status: 200,
    data: responseData
  };
}

/**
 * Completes a password reset with token verification, single-use enforcement, and full session revocation.
 */
export async function completePasswordReset(db, body, ip, userAgent) {
  const { token, new_password } = body || {};

  if (!token || typeof token !== 'string') {
    return {
      status: 400,
      data: { error: { code: 'INVALID_RESET_TOKEN', message: 'A valid password reset token is required' } }
    };
  }

  // Validate new password
  const passCheck = validatePassword(new_password);
  if (!passCheck.ok) {
    return {
      status: 400,
      data: { error: { code: passCheck.code, message: passCheck.message } }
    };
  }

  const tokenHash = await hashToken(token.trim());

  // Find unexpired, unused reset record
  const resetRecord = await db.prepare(`
    SELECT id, user_id, expires_at, used_at
    FROM password_resets
    WHERE token_hash = ?
      AND used_at IS NULL
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).bind(tokenHash).first();

  if (!resetRecord) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_OR_EXPIRED_TOKEN',
          message: 'Password reset token is invalid, already used, or expired'
        }
      }
    };
  }

  // Hash new password
  const { hash, salt } = await hashPassword(new_password);

  const updateUserStmt = db.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(hash, salt, resetRecord.user_id);

  const markUsedStmt = db.prepare(`
    UPDATE password_resets
    SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).bind(resetRecord.id);

  // Revoke ALL active sessions for this user across all devices
  const revokeSessionsStmt = db.prepare(`
    UPDATE user_sessions
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(resetRecord.user_id);

  const auditStmt = db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, target_type, target_id, ip_address, user_agent, metadata_json)
    VALUES (?, ?, 'auth.password_reset_success', 'user', ?, ?, ?, ?)
  `).bind(`aud_${generateUuid()}`, resetRecord.user_id, resetRecord.user_id, ip, userAgent, JSON.stringify({ reset_id: resetRecord.id }));

  // Execute atomically
  if (typeof db.batch === 'function') {
    await db.batch([updateUserStmt, markUsedStmt, revokeSessionsStmt, auditStmt]);
  } else {
    await updateUserStmt.run();
    await markUsedStmt.run();
    await revokeSessionsStmt.run();
    await auditStmt.run();
  }

  return {
    status: 200,
    data: {
      success: true,
      message: 'Password has been reset successfully. All active sessions have been terminated. Please log in with your new password.'
    }
  };
}

/**
 * Controlled helper for manual/testing user activation.
 * Used to transition 'pending_verification' -> 'active' in controlled flows.
 */
export async function activateUserStatus(db, email, status = 'active') {
  await db.prepare(`
    UPDATE users SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE email = ?
  `).bind(status, email.trim().toLowerCase()).run();
}

/**
 * Verifies an applicant's email using a secure single-use token.
 * Atomically transitions user status: 'pending_verification' -> 'active'.
 *
 * @param {object} db - D1 Database
 * @param {string} token - Raw hex verification token
 * @param {string|null} ip - Client IP
 * @param {string|null} userAgent - Client User-Agent
 * @returns {Promise<{ status: number, data: object }>}
 */
export async function verifyEmailToken(db, token, ip = null, userAgent = null) {
  if (!token || typeof token !== 'string' || !/^[a-fA-F0-9]{32,128}$/.test(token.trim())) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_OR_EXPIRED_TOKEN',
          message: 'Verification token is invalid, already used, or expired'
        }
      }
    };
  }

  const tokenHash = await hashToken(token.trim());

  let verificationRecord = null;
  try {
    verificationRecord = await db.prepare(`
      SELECT id, user_id, expires_at, used_at
      FROM email_verifications
      WHERE token_hash = ?
    `).bind(tokenHash).first();
  } catch (err) {
    console.error('[Nexora Nexus Worker Error] Verification lookup failure:', err instanceof Error ? err.message : 'Unknown');
    return {
      status: 503,
      data: {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Verification service is temporarily unavailable. Please try again shortly.'
        }
      }
    };
  }

  // Reject if not found, already used, or expired
  if (!verificationRecord || verificationRecord.used_at !== null) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_OR_EXPIRED_TOKEN',
          message: 'Verification token is invalid, already used, or expired'
        }
      }
    };
  }

  const expiresAtDate = new Date(verificationRecord.expires_at).getTime();
  if (isNaN(expiresAtDate) || Date.now() > expiresAtDate) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_OR_EXPIRED_TOKEN',
          message: 'Verification token is invalid, already used, or expired'
        }
      }
    };
  }

  // Look up user associated with this token
  const user = await db.prepare('SELECT id, email, status FROM users WHERE id = ?').bind(verificationRecord.user_id).first();
  if (!user) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_OR_EXPIRED_TOKEN',
          message: 'Verification token is invalid, already used, or expired'
        }
      }
    };
  }

  // If user is already active, consume token to prevent replay
  if (user.status === 'active') {
    await db.prepare("UPDATE email_verifications SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(verificationRecord.id).run();
    return {
      status: 200,
      data: {
        success: true,
        message: 'Account is already active. You may now sign in.'
      }
    };
  }

  if (user.status !== 'pending_verification') {
    return {
      status: 403,
      data: {
        error: {
          code: 'ACCOUNT_INACTIVE',
          message: `Account is ${user.status}`
        }
      }
    };
  }

  const now = new Date().toISOString();

  // Atomically update user status to active, mark token used, and record audit event
  const updateUserStmt = db.prepare(`
    UPDATE users
    SET status = 'active', updated_at = ?
    WHERE id = ? AND status = 'pending_verification'
  `).bind(now, user.id);

  const updateTokenStmt = db.prepare(`
    UPDATE email_verifications
    SET used_at = ?
    WHERE id = ? AND used_at IS NULL
  `).bind(now, verificationRecord.id);

  const auditStmt = db.prepare(`
    INSERT INTO audit_events (id, actor_id, action, target_type, target_id, ip_address, user_agent, metadata_json, created_at)
    VALUES (?, ?, 'auth.email_verified', 'user', ?, ?, ?, ?, ?)
  `).bind(`aud_${generateUuid()}`, user.id, user.id, ip, userAgent, JSON.stringify({ verification_id: verificationRecord.id }), now);

  try {
    if (typeof db.batch === 'function') {
      await db.batch([updateUserStmt, updateTokenStmt, auditStmt]);
    } else {
      await updateUserStmt.run();
      await updateTokenStmt.run();
      await auditStmt.run();
    }
  } catch (err) {
    console.error('[Nexora Nexus Worker Error] Atomic account activation failure:', err instanceof Error ? err.message : 'Unknown');
    return {
      status: 500,
      data: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred during verification'
        }
      }
    };
  }

  return {
    status: 200,
    data: {
      success: true,
      message: 'Email address verified successfully. You may now sign in to your account.'
    }
  };
}

/**
 * Resends a verification email with rate limiting and anti-enumeration protection.
 *
 * @param {object} db - D1 Database
 * @param {object} body - Request body containing { email }
 * @param {string|null} ip - Client IP
 * @param {string|null} userAgent - Client User-Agent
 * @param {object|null} env - Worker environment
 * @param {object} options - Options (customFetch, origin, isTestEnv)
 * @returns {Promise<{ status: number, data: object }>}
 */
export async function resendVerificationEmail(db, body, ip = null, userAgent = null, env = null, options = {}) {
  const { email } = body || {};

  if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
    return {
      status: 400,
      data: { error: { code: 'INVALID_EMAIL', message: 'A valid email address is required' } }
    };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Rate-limit check: max 3 requests per 15 minutes per email/IP
  // Fail-closed on database error per Phase 30 requirements
  try {
    const ipStr = (ip && typeof ip === 'string' && ip.trim()) ? ip.trim() : '';
    const rateRow = await db.prepare(`
      SELECT COUNT(*) as cnt
      FROM audit_events
      WHERE action = 'auth.verification_resend'
        AND (target_id = ? OR (ip_address = ? AND ip_address != ''))
        AND created_at > datetime('now', '-15 minutes')
    `).bind(normalizedEmail, ipStr).first();

    if (rateRow && Number(rateRow.cnt) >= 3) {
      return {
        status: 429,
        data: {
          error: {
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many verification requests. Please try again in 15 minutes.'
          }
        }
      };
    }
  } catch (err) {
    console.error('[Nexora Nexus Worker Error] Resend rate limit query failure:', err instanceof Error ? err.message : 'Unknown');
    return {
      status: 503,
      data: {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Verification service is temporarily unable to verify rate limits. Please try again shortly.'
        }
      }
    };
  }

  // Anti-enumeration generic response
  const genericResponseData = {
    success: true,
    message: 'If an unverified account exists with that email address, verification instructions have been issued.'
  };

  // Find user by normalized email
  let user = null;
  try {
    user = await db.prepare('SELECT id, email, status FROM users WHERE email = ?').bind(normalizedEmail).first();
  } catch (err) {
    console.error('[Nexora Nexus Worker Error] User lookup failure in resend:', err instanceof Error ? err.message : 'Unknown');
  }

  // If user does not exist or is not pending_verification, equalize timing and return generic response
  if (!user || user.status !== 'pending_verification') {
    await performDummyPasswordCheck('DummyPassword123!');
    await recordAuditEvent(db, {
      action: 'auth.verification_resend',
      targetType: 'user',
      targetId: normalizedEmail,
      ip,
      userAgent,
      metadata: { status: user ? user.status : 'not_found' }
    });

    return {
      status: 200,
      data: genericResponseData
    };
  }

  // User is pending_verification:
  // 1. Invalidate any outstanding unused tokens for this user
  await db.prepare(`
    UPDATE email_verifications
    SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE user_id = ? AND used_at IS NULL
  `).bind(user.id).run();

  // 2. Generate a new 32-byte secure token
  const rawToken = generateSecureToken(32);
  const tokenHash = await hashToken(rawToken);
  const verificationId = `vtok_${generateUuid()}`;
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_DURATION_MS).toISOString();

  await db.prepare(`
    INSERT INTO email_verifications (id, user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(verificationId, user.id, tokenHash, expiresAt, ip, userAgent).run();

  // 3. Record audit event
  await recordAuditEvent(db, {
    actorId: user.id,
    action: 'auth.verification_resend',
    targetType: 'user',
    targetId: user.id,
    ip,
    userAgent
  });

  // 4. Retrieve applicant full name from intern_profiles
  let fullName = 'Applicant';
  try {
    const profile = await db.prepare('SELECT full_name FROM intern_profiles WHERE user_id = ?').bind(user.id).first();
    if (profile && profile.full_name) {
      fullName = profile.full_name;
    }
  } catch {
    // Non-fatal profile lookup error
  }

  // 5. Dispatch email via provider
  await sendVerificationEmail(
    env,
    {
      email: user.email,
      fullName,
      token: rawToken,
      origin: options?.origin || null
    },
    options?.customFetch || null
  );

  const isTestEnv = (env && env.ENVIRONMENT === 'test') || Boolean(options && options.isTestEnv);
  if (isTestEnv) {
    genericResponseData._test_verification_token = rawToken;
  }

  return {
    status: 200,
    data: genericResponseData
  };
}
