/**
 * Nexora Nexus — Secure Cloudflare Worker API Gateway (Hardened Phase 23)
 *
 * Architecture:
 * - Edge API dispatcher for /api/* routes.
 * - Strict same-origin security policy (no wildcard CORS, rejects 'null' origin).
 * - Standardized JSON responses and error envelopes.
 * - Hardened security headers on all API responses (no-store for sensitive APIs).
 * - Authentication & authorization router (Registration, Login, Logout, /me, Reset, Admin guards).
 * - Anti-CSRF verification on cookie-authenticated mutations.
 * - Request size limits (max 64KB JSON body).
 * - Parameterized D1 queries with pagination.
 * - env.ASSETS.fetch(request) passthrough for all static website routes.
 */

import {
  registerApplicant,
  loginUser,
  logoutUser,
  authenticateRequest,
  getCurrentUserProfile,
  requestPasswordReset,
  completePasswordReset,
  verifyEmailToken,
  resendVerificationEmail,
  buildSessionCookie,
  verifyCsrfSafety,
  extractSessionToken,
  getCookie
} from './auth.js';
import {
  getPublishedPrograms,
  submitApplication,
  getMyApplications,
  getApplicationById
} from './applications.js';

// Hardened HTTP security headers applied to all API responses
const API_SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
};

// Maximum allowed request body size (64 KB) to prevent DoS
const MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Creates a standard JSON response with security headers.
 * @param {object} payload - JSON response body
 * @param {number} status - HTTP status code
 * @param {Record<string, string>} extraHeaders - Optional additional headers
 * @returns {Response}
 */
export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...API_SECURITY_HEADERS,
      ...extraHeaders
    }
  });
}

/**
 * Creates a standardized JSON error response.
 * @param {string} code - Machine-readable error code (e.g. NOT_FOUND, METHOD_NOT_ALLOWED)
 * @param {string} message - Human-readable safe error message (no stack traces or internals)
 * @param {number} status - HTTP status code
 * @param {Record<string, string>} extraHeaders - Optional additional headers
 * @returns {Response}
 */
export function errorResponse(code, message, status = 400, extraHeaders = {}) {
  return jsonResponse({
    error: {
      code,
      message
    }
  }, status, extraHeaders);
}

/**
 * Validates request Origin for strict same-origin requests.
 * Rejects untrusted cross-origin requests and malformed/null origins while allowing same-origin clients.
 * @param {Request} request
 * @param {URL} url
 * @returns {boolean}
 */
export function isSameOriginRequest(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) {
    // Direct same-origin GET/fetch without origin header
    return true;
  }
  // Reject opaque / sandbox 'null' origin
  if (origin === 'null') {
    return false;
  }
  return origin === url.origin;
}

/**
 * Handles OPTIONS preflight requests for API routes with strict origin verification.
 * @param {Request} request
 * @param {URL} url
 * @param {string} allowedMethods
 * @returns {Response}
 */
export function handleOptions(request, url, allowedMethods = 'GET, POST, OPTIONS') {
  const origin = request.headers.get('Origin');

  // Strict same-origin policy: Only echo Origin if it matches the current worker origin.
  // Wildcard '*' is NEVER allowed.
  if (origin && origin !== 'null' && origin === url.origin) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': allowedMethods,
        'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, X-Requested-With, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  // If no Origin header, return simple 204 without CORS headers
  if (!origin) {
    return new Response(null, {
      status: 204,
      headers: {
        'Allow': allowedMethods,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  // Cross-origin preflight from unapproved or 'null' origin is rejected
  return errorResponse('CORS_FORBIDDEN', 'Cross-origin requests are forbidden', 403);
}

/**
 * Validates Content-Type for mutating API requests (POST, PUT, PATCH).
 * @param {Request} request
 * @returns {boolean}
 */
export function hasValidJsonContentType(request) {
  const contentType = request.headers.get('Content-Type') || '';
  return contentType.toLowerCase().includes('application/json');
}

/**
 * Safely parses request body as JSON with payload size enforcement.
 * @param {Request} request
 * @returns {Promise<{ ok: boolean, data?: any, error?: string, status?: number }>}
 */
async function parseJsonBody(request) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: 'Payload too large (maximum 64KB allowed)', status: 413 };
  }
  try {
    const text = await request.text();
    if (text.length > MAX_PAYLOAD_BYTES) {
      return { ok: false, error: 'Payload too large (maximum 64KB allowed)', status: 413 };
    }
    if (!text.trim()) return { ok: true, data: {} };
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'Malformed JSON payload', status: 400 };
  }
}

/**
 * Dispatches API requests matching /api/* routes.
 * @param {Request} request
 * @param {URL} url
 * @param {object} env - Cloudflare Worker environment bindings
 * @param {object} ctx - Execution context
 * @returns {Promise<Response>}
 */
export async function handleApiRequest(request, url, env, ctx) {
  const method = request.method.toUpperCase();
  const pathname = url.pathname;
  const isCookieAuth = !!getCookie(request, '__Host-nexora_session');
  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || null;
  const userAgent = request.headers.get('User-Agent') || null;

  // Enforce same-origin check for all API calls
  if (!isSameOriginRequest(request, url)) {
    return errorResponse('CORS_FORBIDDEN', 'Cross-origin requests are forbidden', 403);
  }

  // Check Content-Type for mutating requests with bodies or declared Content-Type
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const contentType = request.headers.get('Content-Type');
    const contentLength = request.headers.get('Content-Length');
    const hasBody = request.body !== null || (contentLength !== null && contentLength !== '0');
    if (contentType || hasBody) {
      if (!hasValidJsonContentType(request)) {
        return errorResponse(
          'UNSUPPORTED_MEDIA_TYPE',
          'Content-Type must be application/json',
          415
        );
      }
    }

    // CSRF verification for mutating requests
    if (!verifyCsrfSafety(request, url, isCookieAuth)) {
      return errorResponse('CSRF_FORBIDDEN', 'Cross-site request validation failed', 403);
    }
  }

  // ============================================================================
  // SYSTEM & HEALTH ROUTES
  // ============================================================================

  // 1. Health check route: GET /api/health
  if (pathname === '/api/health') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'GET, OPTIONS');
    }
    if (method === 'GET') {
      return jsonResponse({
        status: 'ok',
        service: 'nexora-nexus-api',
        environment: (env && env.ENVIRONMENT) || 'production',
        timestamp: new Date().toISOString()
      }, 200);
    }
    return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, {
      'Allow': 'GET, OPTIONS'
    });
  }

  // 2. Base API index route: GET /api or /api/
  if (pathname === '/api' || pathname === '/api/') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'GET, OPTIONS');
    }
    if (method === 'GET') {
      return jsonResponse({
        service: 'nexora-nexus-api',
        version: '1.0.0',
        status: 'operational',
        endpoints: [
          '/api/health',
          '/api/programs',
          '/api/applications',
          '/api/applications/me',
          '/api/auth/register',
          '/api/auth/login',
          '/api/auth/logout',
          '/api/auth/verify-email',
          '/api/auth/resend-verification',
          '/api/auth/forgot-password',
          '/api/auth/reset-password',
          '/api/user/me'
        ]
      }, 200);
    }
    return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, {
      'Allow': 'GET, OPTIONS'
    });
  }

  // ============================================================================
  // AUTHENTICATION ROUTES (/api/auth/*)
  // ============================================================================

  // 3. User Registration: POST /api/auth/register
  if (pathname === '/api/auth/register') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) {
      return errorResponse(parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', parsed.error, parsed.status || 400);
    }

    const result = await registerApplicant(env.DB, parsed.data, clientIp, userAgent, env, {
      origin: url.origin,
      isTestEnv: (env && env.ENVIRONMENT) === 'test'
    });
    return jsonResponse(result.data, result.status);
  }

  // 4. User Login: POST /api/auth/login
  if (pathname === '/api/auth/login') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) {
      return errorResponse(parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', parsed.error, parsed.status || 400);
    }

    const incomingToken = extractSessionToken(request);
    const result = await loginUser(env.DB, parsed.data, clientIp, userAgent, incomingToken);
    const extraHeaders = {};
    if (result.sessionToken) {
      extraHeaders['Set-Cookie'] = buildSessionCookie(result.sessionToken);
    }
    return jsonResponse(result.data, result.status, extraHeaders);
  }

  // 5. User Logout: POST /api/auth/logout
  if (pathname === '/api/auth/logout') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const result = await logoutUser(env.DB, request, clientIp, userAgent);
    return jsonResponse(result.data, result.status, {
      'Set-Cookie': buildSessionCookie(null) // Clears session cookie
    });
  }

  // 6. Password Reset Request: POST /api/auth/forgot-password
  if (pathname === '/api/auth/forgot-password') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) {
      return errorResponse(parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', parsed.error, parsed.status || 400);
    }

    const isEmailConfigured = !!(env && env.EMAIL_PROVIDER);
    const isTestEnv = (env && env.ENVIRONMENT) === 'test';
    const result = await requestPasswordReset(env.DB, parsed.data, clientIp, userAgent, isEmailConfigured, isTestEnv);
    return jsonResponse(result.data, result.status);
  }

  // 7. Password Reset Confirmation: POST /api/auth/reset-password
  if (pathname === '/api/auth/reset-password') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) {
      return errorResponse(parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', parsed.error, parsed.status || 400);
    }

    const result = await completePasswordReset(env.DB, parsed.data, clientIp, userAgent);
    return jsonResponse(result.data, result.status);
  }

  // 8. Email Verification: POST /api/auth/verify-email
  if (pathname === '/api/auth/verify-email') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) {
      return errorResponse(parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', parsed.error, parsed.status || 400);
    }

    const result = await verifyEmailToken(env.DB, parsed.data?.token, clientIp, userAgent);
    return jsonResponse(result.data, result.status);
  }

  // 9. Resend Verification Email: POST /api/auth/resend-verification
  if (pathname === '/api/auth/resend-verification') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) {
      return errorResponse(parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', parsed.error, parsed.status || 400);
    }

    const result = await resendVerificationEmail(env.DB, parsed.data, clientIp, userAgent, env, {
      origin: url.origin,
      isTestEnv: (env && env.ENVIRONMENT) === 'test'
    });
    return jsonResponse(result.data, result.status);
  }

  // ============================================================================
  // USER PROFILE ROUTES (/api/user/*)
  // ============================================================================

  // 8. Current Authenticated Profile: GET /api/user/me
  if (pathname === '/api/user/me') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'GET, OPTIONS');
    }
    if (method !== 'GET') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'GET, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const auth = await authenticateRequest(env.DB, request);
    if (!auth) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
    }

    const result = await getCurrentUserProfile(env.DB, auth.user);
    return jsonResponse(result.data, result.status);
  }

  // ============================================================================
  // ADMIN ROUTES (/api/admin/*) — STRICT SERVER-SIDE ROLE ENFORCEMENT & PAGINATION
  // ============================================================================

  // 9. Admin User List: GET /api/admin/users
  if (pathname === '/api/admin/users') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'GET, OPTIONS');
    }
    if (method !== 'GET') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'GET, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const auth = await authenticateRequest(env.DB, request);
    if (!auth) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
    }

    // Server-side role guard: strictly active 'admin' role required
    if (auth.user.role !== 'admin' || auth.user.status !== 'active') {
      return errorResponse('FORBIDDEN', 'Insufficient permissions for this resource', 403);
    }

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    const offset = (page - 1) * limit;

    const users = await env.DB.prepare(`
      SELECT id, email, role, status, created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    return jsonResponse({
      success: true,
      page,
      limit,
      users: users.results || users
    }, 200);
  }

  // ============================================================================
  // INTERNSHIP PROGRAMS & APPLICATIONS ROUTES (/api/programs, /api/applications/*)
  // ============================================================================

  // 10. Programs Catalog: GET /api/programs
  if (pathname === '/api/programs') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'GET, OPTIONS');
    }
    if (method !== 'GET') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'GET, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }
    const result = await getPublishedPrograms(env.DB);
    return jsonResponse(result.data, result.status);
  }

  // 11. Current Applicant Applications: GET /api/applications/me
  if (pathname === '/api/applications/me') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'GET, OPTIONS');
    }
    if (method !== 'GET') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'GET, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const auth = await authenticateRequest(env.DB, request);
    if (!auth) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
    }

    const result = await getMyApplications(env.DB, auth.user, url);
    return jsonResponse(result.data, result.status);
  }

  // 12. Submit Application: POST /api/applications
  if (pathname === '/api/applications') {
    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'POST, OPTIONS');
    }
    if (method !== 'POST') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'POST, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const auth = await authenticateRequest(env.DB, request);
    if (!auth) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
    }

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) {
      return errorResponse(parsed.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', parsed.error, parsed.status || 400);
    }

    const result = await submitApplication(env.DB, auth.user, parsed.data, clientIp, userAgent);
    return jsonResponse(result.data, result.status);
  }

  // 13. Application Detail: GET /api/applications/:id
  if (pathname.startsWith('/api/applications/')) {
    const applicationId = pathname.slice('/api/applications/'.length);
    if (!applicationId || applicationId.includes('/') || !/^app_[a-zA-Z0-9_-]{1,64}$/.test(applicationId)) {
      return errorResponse('NOT_FOUND', 'API endpoint not found', 404);
    }

    if (method === 'OPTIONS') {
      return handleOptions(request, url, 'GET, OPTIONS');
    }
    if (method !== 'GET') {
      return errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed', 405, { 'Allow': 'GET, OPTIONS' });
    }
    if (!env || !env.DB) {
      return errorResponse('DB_UNAVAILABLE', 'Database service is not configured', 503);
    }

    const auth = await authenticateRequest(env.DB, request);
    if (!auth) {
      return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
    }

    const result = await getApplicationById(env.DB, auth.user, applicationId);
    return jsonResponse(result.data, result.status);
  }

  // Fallback for any unknown /api/* endpoint: return consistent JSON 404
  return errorResponse('NOT_FOUND', 'API endpoint not found', 404);
}

/**
 * Primary Cloudflare Worker entry point.
 */
export default {
  /**
   * @param {Request} request
   * @param {object} env
   * @param {object} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // Route /api and /api/* requests to the Worker API router
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApiRequest(request, url, env, ctx);
      }

      // Delegate all static website routes (HTML, CSS, JS, images, 404) to Cloudflare Static Assets
      if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return await env.ASSETS.fetch(request);
      }

      // Fallback if ASSETS binding is missing (e.g. non-assets testing context)
      return new Response('Asset service unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    } catch (err) {
      // Safe error logging: Record internal error server-side without leaking internals to client
      // Never log sensitive tokens, credentials, or personal information
      console.error('[Nexora Nexus Worker Error]', err instanceof Error ? err.message : 'Unknown error');

      // Return a clean, non-leaking JSON error response
      return errorResponse(
        'INTERNAL_ERROR',
        'An unexpected internal server error occurred',
        500
      );
    }
  }
};
