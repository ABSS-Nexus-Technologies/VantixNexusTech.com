/**
 * Nexora Nexus — Internship Programs & Applications Core (Phase 25)
 *
 * Implements:
 * - Public program listing: GET /api/programs (only published, approved programs with is_active = 1)
 * - Secure application submission: POST /api/applications
 *   - Authenticated, email-verified applicant (status = 'active', role = 'intern')
 *   - User ID strictly derived from session
 *   - Validates program existence and active status
 *   - Prevents duplicate applications (uq_application_user_program)
 *   - Atomic transaction / D1 batch (application insert + audit_event insert)
 *   - Ignores client-supplied status, role, user_id, payment_status
 * - Applicant application list: GET /api/applications/me (paginated, stable order)
 * - Applicant application detail: GET /api/applications/:id (server-side ownership check)
 */

import { generateUuid } from './crypto.js';

const MIN_SOP_LENGTH = 20;
const MAX_SOP_LENGTH = 3000;

/**
 * Retrieves all published and approved internship programs.
 * Only returns programs where is_active = 1.
 * Never fabricates programs or prices. Returns empty array if none found.
 *
 * @param {object} db - D1 Database instance
 * @returns {Promise<{ status: number, data: object }>}
 */
export async function getPublishedPrograms(db) {
  const result = await db.prepare(`
    SELECT
      id,
      slug,
      title,
      description,
      duration_weeks,
      mode,
      price_paise,
      currency,
      max_seats
    FROM internship_programs
    WHERE is_active = 1
    ORDER BY title ASC
  `).all();

  const programs = (result && result.results) ? result.results : (result || []);

  return {
    status: 200,
    data: {
      success: true,
      programs
    }
  };
}

/**
 * Submits an internship application for an authenticated and verified applicant.
 *
 * Security and business rules:
 * 1. User must be authenticated and email-verified (status === 'active').
 * 2. Role must be 'intern'.
 * 3. User ID is derived exclusively from the session user.
 * 4. Program ID is validated against active programs.
 * 5. Prevents duplicate applications per (user_id, program_id).
 * 6. Client cannot supply status, payment_status, role, or approval details.
 * 7. Writes are performed atomically using db.batch().
 *
 * @param {object} db - D1 Database instance
 * @param {object} user - Authenticated user object from session
 * @param {object} body - Request payload
 * @param {string|null} clientIp - Client IP address
 * @param {string|null} userAgent - Client User-Agent
 * @returns {Promise<{ status: number, data: object }>}
 */
export async function submitApplication(db, user, body, clientIp = null, userAgent = null) {
  // 1. Account status check: only verified and active users can apply
  if (!user || user.status === 'pending_verification') {
    return {
      status: 403,
      data: {
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Account is pending email verification. Only verified accounts may submit applications.'
        }
      }
    };
  }

  if (user.status !== 'active') {
    return {
      status: 403,
      data: {
        error: {
          code: 'ACCOUNT_INACTIVE',
          message: `Account is ${user.status}. Active account required to apply.`
        }
      }
    };
  }

  // 2. Role check: only applicants (interns) can apply
  if (user.role !== 'intern') {
    return {
      status: 403,
      data: {
        error: {
          code: 'FORBIDDEN',
          message: 'Only intern applicant accounts can submit applications.'
        }
      }
    };
  }

  // 3. Rate limiting: max 5 application submissions per 15 minutes per user / IP
  try {
    const rateRow = await db.prepare(`
      SELECT COUNT(*) as cnt
      FROM audit_events
      WHERE action = 'application.submitted'
        AND (actor_id = ? OR (ip_address = ? AND ip_address IS NOT NULL AND ip_address != ''))
        AND created_at > datetime('now', '-15 minutes')
    `).bind(user.id, (clientIp && clientIp.trim()) || '').first();

    if (rateRow && Number(rateRow.cnt) >= 5) {
      return {
        status: 429,
        data: {
          error: {
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many application submissions. Please try again in 15 minutes.'
          }
        }
      };
    }
  } catch (err) {
    console.error('[Nexora Nexus Worker Error] Rate limit query failure:', err instanceof Error ? err.message : String(err));
    return {
      status: 503,
      data: {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Submission service is temporarily unable to verify rate limits. Please try again shortly.'
        }
      }
    };
  }

  // 4. Payload validation
  const { program_id, statement_of_purpose } = body || {};

  if (!program_id || typeof program_id !== 'string' || !program_id.trim() || program_id.trim().length > 100) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_INPUT',
          message: 'A valid program_id is required (maximum 100 characters).'
        }
      }
    };
  }

  if (!statement_of_purpose || typeof statement_of_purpose !== 'string') {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_INPUT',
          message: `statement_of_purpose must be a string of at least ${MIN_SOP_LENGTH} characters.`
        }
      }
    };
  }

  const trimmedSop = statement_of_purpose.trim();
  if (trimmedSop.length < MIN_SOP_LENGTH) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_INPUT',
          message: `statement_of_purpose must be at least ${MIN_SOP_LENGTH} characters long.`
        }
      }
    };
  }

  if (trimmedSop.length > MAX_SOP_LENGTH) {
    return {
      status: 400,
      data: {
        error: {
          code: 'INVALID_INPUT',
          message: `statement_of_purpose exceeds maximum length of ${MAX_SOP_LENGTH} characters.`
        }
      }
    };
  }

  const trimmedProgramId = program_id.trim();

  // 5. Validate selected program exists and is published (is_active = 1)
  const program = await db.prepare(`
    SELECT id, slug, title, is_active
    FROM internship_programs
    WHERE (id = ? OR slug = ?) AND is_active = 1
  `).bind(trimmedProgramId, trimmedProgramId).first();

  if (!program) {
    return {
      status: 404,
      data: {
        error: {
          code: 'PROGRAM_NOT_FOUND',
          message: 'Selected internship program not found or is currently inactive.'
        }
      }
    };
  }

  // 6. Prevent duplicate applications according to business rule (uq_application_user_program)
  const existingApp = await db.prepare(`
    SELECT id, status
    FROM applications
    WHERE user_id = ? AND program_id = ?
  `).bind(user.id, program.id).first();

  if (existingApp) {
    return {
      status: 409,
      data: {
        error: {
          code: 'DUPLICATE_APPLICATION',
          message: 'You have already submitted an application for this internship program.'
        }
      }
    };
  }

  // 7. Generate server-controlled IDs and timestamps
  const applicationId = `app_${generateUuid()}`;
  const auditId = `aud_${generateUuid()}`;
  const now = new Date().toISOString();

  // Strictly enforce initial status as 'submitted'; ignore any client status overrides
  const stmtApplication = db.prepare(`
    INSERT INTO applications (
      id,
      user_id,
      program_id,
      status,
      statement_of_purpose,
      submitted_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?)
  `).bind(
    applicationId,
    user.id,
    program.id,
    trimmedSop,
    now,
    now,
    now
  );

  const stmtAudit = db.prepare(`
    INSERT INTO audit_events (
      id,
      actor_id,
      action,
      target_type,
      target_id,
      ip_address,
      user_agent,
      metadata_json,
      created_at
    ) VALUES (?, ?, 'application.submitted', 'application', ?, ?, ?, ?, ?)
  `).bind(
    auditId,
    user.id,
    applicationId,
    clientIp,
    userAgent,
    JSON.stringify({ program_id: program.id, program_slug: program.slug }),
    now
  );

  // 8. Atomic transaction via D1 batch with concurrent unique constraint protection
  try {
    await db.batch([stmtApplication, stmtAudit]);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('uq_application_user_program')) {
      return {
        status: 409,
        data: {
          error: {
            code: 'DUPLICATE_APPLICATION',
            message: 'You have already submitted an application for this internship program.'
          }
        }
      };
    }
    throw err;
  }

  return {
    status: 201,
    data: {
      success: true,
      message: 'Internship application submitted successfully',
      application: {
        id: applicationId,
        program_id: program.id,
        program_title: program.title,
        status: 'submitted',
        submitted_at: now,
        created_at: now
      }
    }
  };
}

/**
 * Retrieves paginated applications for the authenticated applicant.
 * Strictly scoped to user.id with stable ordering (created_at DESC, id DESC).
 * Does not expose internal audit details, resumes, or other users' data.
 *
 * @param {object} db - D1 Database instance
 * @param {object} user - Authenticated user object from session
 * @param {URL} url - Request URL for pagination query parameters
 * @returns {Promise<{ status: number, data: object }>}
 */
export async function getMyApplications(db, user, url) {
  if (!user || user.status === 'pending_verification') {
    return {
      status: 403,
      data: {
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Account is pending email verification.'
        }
      }
    };
  }

  if (user.status !== 'active') {
    return {
      status: 403,
      data: {
        error: {
          code: 'ACCOUNT_INACTIVE',
          message: 'Active account required.'
        }
      }
    };
  }

  const rawPage = parseInt(url.searchParams.get('page') || '1', 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(50, rawLimit) : 20;
  const offset = (page - 1) * limit;

  const countRow = await db.prepare(`
    SELECT COUNT(*) as total
    FROM applications
    WHERE user_id = ?
  `).bind(user.id).first();

  const total = countRow ? Number(countRow.total) : 0;

  const rows = await db.prepare(`
    SELECT
      a.id,
      a.program_id,
      p.title AS program_title,
      p.slug AS program_slug,
      p.duration_weeks,
      p.mode AS program_mode,
      p.price_paise,
      p.currency,
      a.status,
      a.statement_of_purpose,
      a.submitted_at,
      a.created_at,
      a.updated_at
    FROM applications a
    JOIN internship_programs p ON a.program_id = p.id
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).bind(user.id, limit, offset).all();

  const applications = (rows && rows.results) ? rows.results : (rows || []);

  return {
    status: 200,
    data: {
      success: true,
      page,
      limit,
      total,
      applications
    }
  };
}

/**
 * Retrieves a single application by ID for the authenticated applicant.
 * Enforces ownership on the server: returns 404 if not found or belongs to another user.
 *
 * @param {object} db - D1 Database instance
 * @param {object} user - Authenticated user object from session
 * @param {string} applicationId - Application ID
 * @returns {Promise<{ status: number, data: object }>}
 */
export async function getApplicationById(db, user, applicationId) {
  if (!user || user.status === 'pending_verification') {
    return {
      status: 403,
      data: {
        error: {
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Account is pending email verification.'
        }
      }
    };
  }

  if (user.status !== 'active') {
    return {
      status: 403,
      data: {
        error: {
          code: 'ACCOUNT_INACTIVE',
          message: 'Active account required.'
        }
      }
    };
  }

  if (!applicationId || typeof applicationId !== 'string' || !/^app_[a-zA-Z0-9_-]{1,64}$/.test(applicationId.trim())) {
    return {
      status: 404,
      data: {
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: 'Application not found.'
        }
      }
    };
  }

  // Server-side ownership check: WHERE a.id = ? AND a.user_id = ?
  const app = await db.prepare(`
    SELECT
      a.id,
      a.program_id,
      p.title AS program_title,
      p.slug AS program_slug,
      p.duration_weeks,
      p.mode AS program_mode,
      p.price_paise,
      p.currency,
      a.status,
      a.statement_of_purpose,
      a.submitted_at,
      a.created_at,
      a.updated_at
    FROM applications a
    JOIN internship_programs p ON a.program_id = p.id
    WHERE a.id = ? AND a.user_id = ?
  `).bind(applicationId.trim(), user.id).first();

  if (!app) {
    return {
      status: 404,
      data: {
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: 'Application not found.'
        }
      }
    };
  }

  return {
    status: 200,
    data: {
      success: true,
      application: app
    }
  };
}
