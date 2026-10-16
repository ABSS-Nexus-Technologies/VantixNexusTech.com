# Nexora Nexus — Backend API Specifications & Contracts (Phase 24)

## Architecture Overview
The Nexora Nexus backend is deployed as a unified Cloudflare Worker with Cloudflare Static Assets.
- **Base Domain**: `https://vantixnexustech-com.abssnexus.workers.dev`
- **API Prefix**: `/api/*`
- **Static Assets**: All non-`/api` routes pass directly through to `env.ASSETS.fetch(request)`
- **Security Headers Enforced on All API Responses**:
  - `Content-Type: application/json; charset=utf-8`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`

---

## 1. System & Health Endpoints

### 1.1 `GET /api/health`
- **Purpose**: System health and edge operational verification.
- **Authentication**: None (Public).
- **CSRF Requirements**: None.
- **Request Headers**: Standard GET.
- **Success Response**: HTTP 200
  ```json
  {
    "status": "ok",
    "service": "nexora-nexus-api",
    "environment": "production",
    "timestamp": "2026-10-13T17:30:00.000Z"
  }
  ```
- **Error Responses**:
  - `405 METHOD_NOT_ALLOWED`: Any method other than `GET` or `OPTIONS`.
- **Database Side Effects**: None.
- **Status**: **Fully Operational**.

---

### 1.2 `GET /api` (API Catalog)
- **Purpose**: Public index of registered API endpoints.
- **Authentication**: None (Public).
- **CSRF Requirements**: None.
- **Success Response**: HTTP 200
  ```json
  {
    "service": "nexora-nexus-api",
    "version": "1.0.0",
    "status": "operational",
    "endpoints": [
      "/api/health",
      "/api/programs",
      "/api/applications",
      "/api/applications/me",
      "/api/auth/register",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/verify-email",
      "/api/auth/resend-verification",
      "/api/auth/forgot-password",
      "/api/auth/reset-password",
      "/api/user/me"
    ]
  }
  ```
- **Database Side Effects**: None.
- **Status**: **Fully Operational**.

---

## 2. Authentication & Authorization Endpoints

### 2.1 `POST /api/auth/register`
- **Purpose**: Self-service registration for intern applicants.
- **Authentication**: None (Public).
- **Role Restrictions**: Role is strictly hardcoded to `intern`. Explicit requests for `admin`, `mentor`, or `reviewer` are rejected.
- **CSRF Requirements**:
  - `Origin` must match worker origin (or be absent on simple same-origin requests).
  - `Sec-Fetch-Site` must not be `cross-site`.
  - `Sec-Fetch-Mode` must not be `navigate`.
  - Content-Type must be `application/json`.
  - Maximum body size: 64 KB.
- **Request Body**:
  | Field | Type | Required | Constraints |
  | :--- | :--- | :--- | :--- |
  | `email` | string | Yes | Valid email format (`EMAIL_REGEX`), normalized to lowercase |
  | `password` | string | Yes | Min 8 chars, Max 128 chars, uppercase, lowercase, numeric |
  | `full_name` | string | Yes | Min 2 chars |
  | `phone` | string | No | Optional phone number |
  | `college` | string | No | Optional university name |
  | `graduation_year` | integer | No | 4-digit year |
  | `linkedin_url` | string | No | Optional URL |
  | `github_url` | string | No | Optional URL |
  | `portfolio_url` | string | No | Optional URL |
- **Success Response**: HTTP 201
  ```json
  {
    "success": true,
    "message": "Account created. Account status is pending email verification.",
    "user": {
      "id": "usr_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
      "email": "applicant@example.com",
      "role": "intern",
      "status": "pending_verification"
    }
  }
  ```
- **Error Responses**:
  - `400 INVALID_ROLE`: If client requests non-intern role.
  - `400 INVALID_EMAIL`: Malformed email address.
  - `400 INVALID_NAME`: Full name missing or < 2 characters.
  - `400 WEAK_PASSWORD`: Password < 8 characters or lacks uppercase/lowercase/numbers.
  - `400 PASSWORD_TOO_LONG`: Password > 128 characters.
  - `409 EMAIL_EXISTS`: Email is already registered.
  - `413 PAYLOAD_TOO_LARGE`: Body exceeds 64 KB.
  - `415 UNSUPPORTED_MEDIA_TYPE`: Content-Type is not `application/json`.
  - `403 CSRF_FORBIDDEN`: Origin mismatch or `Sec-Fetch-Site: cross-site`.
  - `503 DB_UNAVAILABLE`: Cloudflare D1 binding is unconfigured.
- **Database Side Effects**:
  - Inserts row into `users` (`role = 'intern'`, `status = 'pending_verification'`).
  - Inserts row into `intern_profiles`.
  - Inserts row into `audit_events` (`action = 'user.registered'`).
  - Atomic batch execution via `db.batch()`.
- **Status**: **Fully Operational** (Account placed in `pending_verification`).

---

### 2.2 `POST /api/auth/login`
- **Purpose**: Authenticates credentials, rotates sessions, and issues secure `__Host-` session cookie.
- **Authentication**: None (Public).
- **CSRF Requirements**:
  - Origin check enforced.
  - If client presents pre-existing session cookie, requires `X-CSRF-Token` or `X-Requested-With`.
- **Request Body**:
  | Field | Type | Required | Constraints |
  | :--- | :--- | :--- | :--- |
  | `email` | string | Yes | Lowercased, trimmed |
  | `password` | string | Yes | Plaintext (checked in constant-time via PBKDF2) |
- **Success Response**: HTTP 200
  - **Headers**:
    `Set-Cookie: __Host-nexora_session=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`
  - **Body**:
    ```json
    {
      "success": true,
      "message": "Login successful",
      "user": {
        "id": "usr_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
        "email": "applicant@example.com",
        "role": "intern",
        "status": "active"
      },
      "csrf_token": "<24-byte-hex-token>"
    }
    ```
- **Error Responses**:
  - `400 INVALID_CREDENTIALS`: Missing email or password.
  - `401 INVALID_CREDENTIALS`: Incorrect email or password (constant-time response via dummy calculation).
  - `403 EMAIL_NOT_VERIFIED`: User status is `pending_verification`.
  - `403 ACCOUNT_INACTIVE`: User status is `suspended` or `deactivated`.
  - `429 TOO_MANY_REQUESTS`: Exceeded 5 failed login attempts in 15 minutes.
- **Database Side Effects**:
  - If previous session presented, revokes old session (`revoked_at = datetime('now')`).
  - Inserts fresh row into `user_sessions` with `SHA-256(token)` as `token_hash` and 7-day expiry.
  - Inserts row into `audit_events` (`action = 'auth.login_success'` or `'auth.login_failure'`).
- **Status**: **Fully Operational** (requires `active` account status).

---

### 2.3 `POST /api/auth/logout`
- **Purpose**: Terminates current session, sets revocation timestamp in DB, and clears client cookie.
- **Authentication**: Session cookie (`__Host-nexora_session`) or `Authorization: Bearer <token>`.
- **CSRF Requirements**: Requires `X-CSRF-Token` or `X-Requested-With` header on cookie requests.
- **Success Response**: HTTP 200
  - **Headers**:
    `Set-Cookie: __Host-nexora_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
  - **Body**:
    ```json
    {
      "success": true,
      "message": "Logged out successfully"
    }
    ```
- **Database Side Effects**:
  - Sets `revoked_at = datetime('now')` on matching `user_sessions` row.
  - Records audit log in `audit_events` (`action = 'auth.logout'`).
- **Status**: **Fully Operational**.

---

### 2.4 `POST /api/auth/forgot-password`
- **Purpose**: Requests a password reset.
- **Authentication**: None (Public).
- **CSRF Requirements**: Origin check enforced.
- **Request Body**:
  | Field | Type | Required |
  | :--- | :--- | :--- |
  | `email` | string | Yes |
- **Operational Reality**:
  - **In Production (Email unconfigured)**: Returns HTTP 503 `EMAIL_SERVICE_NOT_CONFIGURED`:
    ```json
    {
      "error": {
        "code": "EMAIL_SERVICE_NOT_CONFIGURED",
        "message": "Password reset via email is currently unavailable because transactional email delivery has not been configured. Please contact support or an administrator."
      }
    }
    ```
    *Never returns fake success claiming an email was sent.*
  - **In Test Environment (`ENVIRONMENT = 'test'`) or when email provider is configured**:
    - Rate limits to max 3 requests per 15 minutes (`429 TOO_MANY_REQUESTS`).
    - Invalidates any pre-existing active reset tokens for that user.
    - Generates 32-byte secure token, stores `SHA-256` hash in `password_resets` with 1-hour expiry.
    - Returns HTTP 200 anti-enumeration message.
- **Database Side Effects**: Inserts row into `password_resets` and `audit_events`.
- **Status**: **Gated by Missing Infrastructure** (Honest 503 in production; fully operational in test mode).

---

### 2.5 `POST /api/auth/reset-password`
- **Purpose**: Completes password reset using a single-use token, updates password, and revokes all active sessions.
- **Authentication**: Token-based.
- **CSRF Requirements**: Origin check enforced.
- **Request Body**:
  | Field | Type | Required | Constraints |
  | :--- | :--- | :--- | :--- |
  | `token` | string | Yes | 64-char hex token issued by forgot-password |
  | `new_password` | string | Yes | Min 8 chars, Max 128 chars, uppercase, lowercase, numeric |
- **Success Response**: HTTP 200
  ```json
  {
    "success": true,
    "message": "Password has been reset successfully. All active sessions have been terminated. Please log in with your new password."
  }
  ```
- **Error Responses**:
  - `400 INVALID_RESET_TOKEN`: Missing token.
  - `400 INVALID_OR_EXPIRED_TOKEN`: Token expired, already used, or invalid.
  - `400 WEAK_PASSWORD` / `PASSWORD_TOO_LONG`: Password complexity validation failure.
- **Database Side Effects**:
  - Updates `users.password_hash` and `password_salt`.
  - Marks `password_resets.used_at = datetime('now')`.
  - **Revokes ALL active sessions for this user in `user_sessions`** across all devices.
  - Records audit event `auth.password_reset_success`.
  - Executed atomically via `db.batch()`.
- **Status**: **Fully Operational**.

---

### 2.6 `POST /api/auth/verify-email`
- **Purpose**: Verifies applicant email address using single-use 256-bit token and activates account.
- **Authentication**: None (Token-based).
- **CSRF Requirements**: Same-origin verification enforced.
- **Request Body**:
  | Field | Type | Required | Constraints |
  | :--- | :--- | :--- | :--- |
  | `token` | string | Yes | 64-character hex token issued at registration or resend |
- **Success Response**: HTTP 200
  ```json
  {
    "success": true,
    "message": "Email address verified successfully. You may now sign in to your account."
  }
  ```
- **Error Responses**:
  - `400 INVALID_OR_EXPIRED_TOKEN`: Missing, malformed, expired (>24 hours), already consumed, or unrecorded token hash.
  - `403 ACCOUNT_INACTIVE`: Account is suspended or deactivated.
  - `503 SERVICE_UNAVAILABLE`: Database lookup failure.
- **Security & Integrity Rules**:
  - Tokens expire in **24 hours**.
  - Single-use: Verified token immediately receives `used_at = datetime('now')`. Replay attempts fail with HTTP 400.
  - Database stores only `SHA-256(token)` as `token_hash` in `email_verifications`. Raw tokens are never persisted or logged.
  - User status transition (`pending_verification` -> `active`) and token consumption execute atomically via `db.batch()`.
  - Does NOT automatically issue session cookie; users log in via standard `/api/auth/login`.
- **Status**: **Fully Operational (Local Tested)**.

---

### 2.7 `POST /api/auth/resend-verification`
- **Purpose**: Issues a fresh verification link and invalidates pre-existing active tokens.
- **Authentication**: None (Public).
- **CSRF Requirements**: Same-origin verification enforced.
- **Request Body**:
  | Field | Type | Required | Constraints |
  | :--- | :--- | :--- | :--- |
  | `email` | string | Yes | Valid email address (`EMAIL_REGEX`) |
- **Success Response**: HTTP 200 (Anti-Enumeration Generic Envelope)
  ```json
  {
    "success": true,
    "message": "If an unverified account exists with that email address, verification instructions have been issued."
  }
  ```
- **Error Responses**:
  - `400 INVALID_EMAIL`: Missing or malformed email format.
  - `429 TOO_MANY_REQUESTS`: Rate limit exceeded (maximum 3 requests per 15 minutes per email/IP).
  - `503 SERVICE_UNAVAILABLE`: Fail-closed on database rate limit errors.
- **Security & Integrity Rules**:
  - Anti-enumeration: Returns identical generic message regardless of whether the email is registered, active, or pending.
  - Timing equalization: Non-existent or non-pending addresses trigger dummy PBKDF2 calculation.
  - Invalidation: Calling resend immediately sets `used_at = datetime('now')` on any pre-existing active verification tokens for that user before generating a new token.
  - Rate limiting: Max 3 requests per 15 minutes tracked via `audit_events` (`action = 'auth.verification_resend'`).
- **Status**: **Fully Operational (Local Tested)**.

---

### 2.8 Transactional Email Delivery Architecture (Resend API)
- **Module**: `worker/email.js`
- **Provider**: Resend (`https://api.resend.com/emails`)
- **Required Cloudflare Environment Variables**:
  | Variable | Type | Description |
  | :--- | :--- | :--- |
  | `EMAIL_PROVIDER` | Var | Must be set to `"resend"` to activate delivery. |
  | `EMAIL_API_KEY` | Secret | Resend API Bearer token (`re_...`). |
  | `EMAIL_FROM` | Var/Secret | Verified sender address (e.g. `admissions@nexoranexus.com`). |
  | `APP_BASE_URL` | Var | Configured public base URL (e.g. `https://nexoranexus.com`). |
- **Security & Logging Rules**:
  - Raw tokens and full verification URLs are **never logged** in console or application logs.
  - User-supplied names and emails are strictly HTML entity-escaped (`escapeHtml`) before insertion into email templates to prevent HTML injection/XSS.
  - Verification links use validated origins or configured `APP_BASE_URL` (untrusted `Host` headers are rejected).
  - When credentials are unset, registration succeeds in `pending_verification` without false delivery claims.
- **Deployment Status**: Awaiting remote Cloudflare secret configuration (`wrangler secret put EMAIL_API_KEY`).

---

## 3. User & Administrative Endpoints

### 3.1 `GET /api/user/me`
- **Purpose**: Returns the authenticated profile of the currently logged-in user.
- **Authentication**: Requires active, unexpired, unrevoked session cookie or Bearer token.
- **Role Requirements**: Any authenticated user (`intern`, `mentor`, `reviewer`, `admin`).
- **Authorization Enforcement**: Strictly scoped to session user ID (`WHERE u.id = ?`). Users cannot supply another user's ID.
- **Success Response**: HTTP 200
  ```json
  {
    "success": true,
    "user": {
      "id": "usr_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
      "email": "applicant@example.com",
      "role": "intern",
      "status": "active",
      "created_at": "2026-10-13T17:00:00.000Z",
      "full_name": "Alice Johnson",
      "phone": "9876543210",
      "college": "Indian Institute of Technology",
      "graduation_year": 2026,
      "linkedin_url": "https://linkedin.com/in/alice",
      "github_url": "https://github.com/alice",
      "portfolio_url": "https://alice.dev"
    }
  }
  ```
- **Error Responses**:
  - `401 UNAUTHORIZED`: Missing, expired, or revoked session token.
  - `404 PROFILE_NOT_FOUND`: User row not found.
- **Database Side Effects**: None (Read-only query).
- **Status**: **Fully Operational**.

---

### 3.2 `GET /api/admin/users`
- **Purpose**: Paginated list of registered users for administrative management.
- **Authentication**: Required.
- **Role Requirements**: Strictly `admin`. Non-admin accounts (`intern`, `mentor`, `reviewer`) are denied access.
- **Query Parameters**:
  - `page`: integer (default: 1, minimum: 1)
  - `limit`: integer (default: 50, maximum: 100)
- **Success Response**: HTTP 200
  ```json
  {
    "success": true,
    "page": 1,
    "limit": 50,
    "users": [
      {
        "id": "usr_xxxxxxxx",
        "email": "intern@example.com",
        "role": "intern",
        "status": "active",
        "created_at": "2026-10-13T17:00:00.000Z"
      }
    ]
  }
  ```
- **Error Responses**:
  - `401 UNAUTHORIZED`: Unauthenticated request.
  - `403 FORBIDDEN`: User does not possess `admin` role.
- **Database Side Effects**: None (Read-only parameterized query with `LIMIT ? OFFSET ?`).
- **Status**: **Fully Operational**.

---

---

## 4. Internship Programs & Applications Endpoints (Phase 25)

### 4.1 `GET /api/programs`
- **Purpose**: Retrieve published, explicitly approved internship programs for public browsing.
- **Authentication**: None (Public).
- **CSRF Requirements**: None (Read GET).
- **Filtering Rules**: Only programs where `is_active = 1` are returned. Does not fabricate programs or pricing. Returns empty list if no active programs exist.
- **Success Response**: HTTP 200
  ```json
  {
    "success": true,
    "programs": [
      {
        "id": "prg_fullstack_2026",
        "slug": "full-stack-web-development",
        "title": "Full Stack Web Development",
        "description": "Comprehensive full stack engineering program.",
        "duration_weeks": 8,
        "mode": "remote",
        "price_paise": 0,
        "currency": "INR",
        "max_seats": 50
      }
    ]
  }
  ```
- **Error Responses**:
  - `405 METHOD_NOT_ALLOWED`: Any method other than `GET` or `OPTIONS`.
- **Database Side Effects**: None (Read-only parameterized query).
- **Status**: **Fully Operational**.

---

### 4.2 `POST /api/applications`
- **Purpose**: Submit an internship application for an authenticated and verified applicant.
- **Authentication**: Required (`__Host-nexora_session` cookie or Bearer token).
- **Role Requirements**: Strictly `intern`.
- **Status Requirements**: User `status` must be `active`. Unverified accounts (`pending_verification`) are rejected with HTTP 403 `EMAIL_NOT_VERIFIED`.
- **CSRF Requirements**:
  - `Origin` must match worker origin.
  - `Sec-Fetch-Site` must not be `cross-site`.
  - `Sec-Fetch-Mode` must not be `navigate`.
  - Mutating cookie requests must include `X-CSRF-Token` or `X-Requested-With`.
  - Maximum body size: 64 KB.
- **Request Body**:
  | Field | Type | Required | Constraints |
  | :--- | :--- | :--- | :--- |
  | `program_id` | string | Yes | Non-empty string; maximum 100 characters; must match an active program (`is_active = 1`) by ID or slug |
  | `statement_of_purpose` | string | Yes | Min 20 characters, Max 3000 characters |
- **Security & Integrity Rules**:
  - `user_id` is derived **exclusively** from the authenticated server session.
  - Client attempts to supply `status`, `payment_status`, `role`, or `user_id` are strictly ignored.
  - Status is unconditionally set to `'submitted'`.
  - Seat limit policy (`max_seats`) is **intentionally deferred** at application submission time; applications are created in `submitted` status awaiting admissions review.
  - Rate limiting enforced: Maximum 5 application submissions per 15-minute sliding window per user or IP address.
  - Duplicate submissions for the same program by the same user are rejected with HTTP 409 `DUPLICATE_APPLICATION` (`uq_application_user_program`), with race condition protection in `db.batch()`.
  - Database writes use `db.batch()` to atomically insert the application and the audit event.
- **Success Response**: HTTP 201
  ```json
  {
    "success": true,
    "message": "Internship application submitted successfully",
    "application": {
      "id": "app_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
      "program_id": "prg_fullstack_2026",
      "program_title": "Full Stack Web Development",
      "status": "submitted",
      "submitted_at": "2026-10-13T18:00:00.000Z",
      "created_at": "2026-10-13T18:00:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `400 INVALID_INPUT`: Missing/invalid `program_id` (or > 100 chars), or `statement_of_purpose` not meeting length requirements.
  - `401 UNAUTHORIZED`: Missing, expired, or invalid session.
  - `403 EMAIL_NOT_VERIFIED`: User account has not verified their email.
  - `403 FORBIDDEN`: Non-intern role attempting to submit application.
  - `404 PROGRAM_NOT_FOUND`: Program does not exist or is inactive (`is_active = 0`).
  - `409 DUPLICATE_APPLICATION`: Application already exists for this program and applicant.
  - `413 PAYLOAD_TOO_LARGE`: Body exceeds 64 KB.
  - `415 UNSUPPORTED_MEDIA_TYPE`: Missing `application/json` Content-Type.
  - `429 TOO_MANY_REQUESTS`: Exceeded 5 application submissions per 15 minutes.
- **Database Side Effects**: Atomic insert into `applications` and `audit_events`.
- **Status**: **Fully Operational**.

---

### 4.3 `GET /api/applications/me`
- **Purpose**: Paginated retrieval of applications submitted by the currently authenticated applicant.
- **Authentication**: Required.
- **Status Requirements**: Active user status required.
- **Query Parameters**:
  - `page`: integer (default: 1, minimum: 1)
  - `limit`: integer (default: 20, maximum: 50)
- **Ordering**: Deterministic and stable (`ORDER BY a.created_at DESC, a.id DESC`).
- **Data Isolation**: Strictly scoped to `WHERE a.user_id = auth.user.id`. Does not expose internal audit details, resumes, review comments, or other applicants' data.
- **Success Response**: HTTP 200
  ```json
  {
    "success": true,
    "page": 1,
    "limit": 20,
    "total": 1,
    "applications": [
      {
        "id": "app_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
        "program_id": "prg_fullstack_2026",
        "program_title": "Full Stack Web Development",
        "program_slug": "full-stack-web-development",
        "duration_weeks": 8,
        "program_mode": "remote",
        "price_paise": 0,
        "currency": "INR",
        "status": "submitted",
        "statement_of_purpose": "My statement of purpose...",
        "submitted_at": "2026-10-13T18:00:00.000Z",
        "created_at": "2026-10-13T18:00:00.000Z",
        "updated_at": "2026-10-13T18:00:00.000Z"
      }
    ]
  }
  ```
- **Error Responses**:
  - `401 UNAUTHORIZED`: Missing or invalid session.
  - `403 ACCOUNT_INACTIVE`: Account is inactive or unverified.
- **Database Side Effects**: None (Read-only query).
- **Status**: **Fully Operational**.

---

### 4.4 `GET /api/applications/:id`
- **Purpose**: Retrieve details of a specific application.
- **Authentication**: Required.
- **Server-Side Ownership Guard**: Strictly enforced via `WHERE a.id = ? AND a.user_id = ?`. If the application does not belong to the authenticated user, HTTP 404 is returned to prevent application ID enumeration.
- **Success Response**: HTTP 200
  ```json
  {
    "success": true,
    "application": {
      "id": "app_xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
      "program_id": "prg_fullstack_2026",
      "program_title": "Full Stack Web Development",
      "program_slug": "full-stack-web-development",
      "duration_weeks": 8,
      "program_mode": "remote",
      "price_paise": 0,
      "currency": "INR",
      "status": "submitted",
      "statement_of_purpose": "My statement of purpose...",
      "submitted_at": "2026-10-13T18:00:00.000Z",
      "created_at": "2026-10-13T18:00:00.000Z",
      "updated_at": "2026-10-13T18:00:00.000Z"
    }
  }
  ```
- **Error Responses**:
  - `401 UNAUTHORIZED`: Missing or invalid session.
  - `403 ACCOUNT_INACTIVE`: Account is inactive or unverified.
  - `404 APPLICATION_NOT_FOUND`: Application does not exist or does not belong to user.
- **Database Side Effects**: None (Read-only query).
- **Status**: **Fully Operational**.

---

## 5. Summary of Operational Status & Gated Features

| Endpoint | Method | Operational Status | Blocker / Dependency |
| :--- | :--- | :--- | :--- |
| `/api/health` | GET | **Fully Operational** | None |
| `/api` | GET | **Fully Operational** | None |
| `/api/programs` | GET | **Fully Operational** | Published programs (`is_active = 1`) |
| `/api/applications` | POST | **Fully Operational** | Authenticated, email-verified applicants |
| `/api/applications/me` | GET | **Fully Operational** | Authenticated applicant |
| `/api/applications/:id` | GET | **Fully Operational** | Authenticated applicant (ownership verified) |
| `/api/auth/register` | POST | **Fully Operational** | Creates `pending_verification` accounts |
| `/api/auth/login` | POST | **Fully Operational** | Blocks unverified users (`403 EMAIL_NOT_VERIFIED`) |
| `/api/auth/logout` | POST | **Fully Operational** | Revokes session and clears cookie |
| `/api/auth/forgot-password` | POST | **Honest Infrastructure Gate** | Returns 503 until transactional email provider is configured; operational in test mode |
| `/api/auth/reset-password` | POST | **Fully Operational** | Validates single-use token and revokes all sessions |
| `/api/user/me` | GET | **Fully Operational** | Session-scoped |
| `/api/admin/users` | GET | **Fully Operational** | Server-side role guard (`role === 'admin'`) |
| `/api/*` (unknown) | * | **Fully Operational** | Consistent JSON 404 response |

---

## 6. Database Schema & Migration Notes

- **Migration Status**: **No new SQL migration file required for Phase 25.**
- **Schema Coverage**: `migrations/0001_initial_schema.sql` already specifies:
  - Table `internship_programs` with `is_active`, `price_paise`, and `currency`.
  - Table `applications` with `status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'enrolled', 'completed', 'withdrawn')`.
  - Unique constraint `uq_application_user_program UNIQUE (user_id, program_id)`.
  - Indexes `idx_applications_user`, `idx_applications_program`, `idx_applications_status`, `idx_internship_programs_active`.
