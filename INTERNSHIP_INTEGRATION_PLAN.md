# Nexora Nexus — Internship Application Integration Plan (Phase 24)

## Executive Summary
This document specifies the end-to-end architectural and integration plan for connecting the Nexora Nexus frontend website with the Cloudflare Worker backend and D1 database for the Internship Platform.

Per strict project mandates, the public form on `internships.html` is **not connected in this phase**. No program fees, refund policies, available vacancies, stipend promises, or placement guarantees are invented.

---

## 1. Current State vs. Proposed Architecture

| Component | Current State (Phase 24) | Proposed / Target State |
| :--- | :--- | :--- |
| **Frontend Form (`internships.html`)** | Client-side validation active; submission safely halted without backend endpoint. | Authenticated form communicating with `/api/applications`. |
| **Authentication Backend** | Operational (`register`, `login`, `logout`, `user/me`, password reset). | Operational; will serve as gatekeeper for application submission. |
| **Email Verification** | Schema supports `pending_verification`; endpoint blocked by email provider. | Dedicated verification link endpoint (`/api/auth/verify-email`). |
| **Internship Programs Catalog** | Schema table `internship_programs` created in D1. | Public read endpoint `GET /api/programs` reading active programs. |
| **Application Submission** | Schema table `applications` created in D1. | Authenticated endpoint `POST /api/applications`. |
| **Payment Gateway** | Schema tables `payment_orders` and `payment_records` created in D1. | Server-side Razorpay order creation and webhook verification. |
| **Applicant Dashboard** | Endpoint `/api/user/me` returns user profile. | Dedicated endpoints `GET /api/applications/me` for tracking progress. |
| **Program Pricing / Fees** | Stored in D1 as integer paise (`price_paise`); zero fees configured. | Exact fees and refund terms to be determined by business management. |

---

## 2. Intended End-to-End User Flow

```
[ Step 1: Register ]
       │
       ▼
[ Step 2: Email Verification ] ──(Awaiting Provider)──► [ Account Status: Active ]
                                                              │
                                                              ▼
                                                     [ Step 3: Sign In ]
                                                              │
                                                              ▼
                                            [ Step 4: View Program & Terms ]
                                                              │
                                                              ▼
                                                [ Step 5: Submit Application ]
                                                              │
                                     ┌────────────────────────┴────────────────────────┐
                                     │ (If Fee Required)                               │ (If Free / Fully Sponsored)
                                     ▼                                                 ▼
                          [ Step 6: Server Payment ]                         [ Application Under Review ]
                         (Order -> Razorpay -> Webhook)                                │
                                     │                                                 │
                                     └────────────────────────┬────────────────────────┘
                                                              │
                                                              ▼
                                              [ Step 7: View Status & Enroll ]
```

### Step 1 — Applicant Registers
- **User Action**: Applicant completes the registration form with email, password (minimum 8 characters, upper/lower/digit/special), full name, and optional academic/social profiles (college, graduation year, LinkedIn, GitHub).
- **Endpoint**: `POST /api/auth/register` (Implemented & Verified).
- **Backend Behavior**:
  - Validates input format and length constraints.
  - Generates unique ID (`usr_...`).
  - Hashes password using PBKDF2-HMAC-SHA256 (100,000 iterations, 32-byte salt).
  - Inserts record into `users` with `role = 'intern'` and `status = 'pending_verification'`.
  - Inserts profile into `intern_profiles`.
  - Rejects privilege escalation requests (`admin`, `mentor`, etc.).

### Step 2 — Applicant Verifies Email
- **User Action**: Applicant receives an automated verification email containing a secure, single-use activation link.
- **Endpoint**: `GET /api/auth/verify-email?token=...` (Proposed).
- **Current Operational Reality**:
  - No transactional email provider is currently bound in Cloudflare Worker environment.
  - Accounts currently remain in `pending_verification`.
  - Attempting to log in with an unverified account returns HTTP 403 `EMAIL_NOT_VERIFIED`.
  - In local testing, accounts are activated directly via `activateUserStatus(db, email, 'active')`.
- **Target Implementation**:
  - Once Cloudflare Email Routing, SendGrid, or Resend is configured, a cryptographically secure token (32 bytes) will be hashed into an `email_verifications` table.
  - Clicking the link verifies the token, marks it used, and transitions user `status` to `'active'`.

### Step 3 — Applicant Signs In
- **User Action**: Verified applicant enters email and password.
- **Endpoint**: `POST /api/auth/login` (Implemented & Verified).
- **Backend Behavior**:
  - Rate-limiting check: Throttles after 5 consecutive failures within 15 minutes.
  - Verifies credentials using constant-time timing-safe PBKDF2 check.
  - Enforces `status === 'active'` check; blocks `pending_verification` or `suspended`.
  - Performs session rotation: revokes existing session if present.
  - Generates 256-bit secure session token and issues `__Host-nexora_session` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`).

### Step 4 — Applicant Views Confirmed Program Details & Fee/Refund Terms
- **User Action**: Authenticated applicant browses available internship tracks on `internships.html` or a program catalog view.
- **Endpoint**: `GET /api/programs` & `GET /api/programs/:slug` (Proposed).
- **Data Source**: D1 `internship_programs` table:
  - `slug`: e.g., `full-stack-web-development`, `cloud-devops`, `ai-machine-learning`.
  - `title`, `description`, `duration_weeks`, `mode` (`remote`, `hybrid`, `onsite`).
  - `price_paise`: Integer paise (1 INR = 100 paise).
  - `currency`: Strictly `'INR'`.
  - `is_active`: Only active programs are listed.
- **Strict Business Policy**:
  - The platform **never hardcodes pricing or refund guarantees in client JavaScript**.
  - Program fees, refund eligibility periods, and payment deadlines must be explicitly defined by business stakeholders before any program is marked `is_active = 1`.
  - Terms and conditions must be acknowledged by applicant before application submission.

### Step 5 — Applicant Submits an Application
- **User Action**: Applicant selects a track, writes a Statement of Purpose (SOP), attaches/uploads a resume, and submits.
- **Endpoint**: `POST /api/applications` (Proposed).
- **Backend Behavior**:
  - Validates active session via `__Host-nexora_session`.
  - Checks if applicant already has an active application for this program (`uq_application_user_program`).
  - If a resume file is uploaded, transfers safely to Cloudflare R2 bucket with private access key (`resume_r2_key`), validating MIME type (PDF only, max 5 MB).
  - Inserts record into `applications`:
    - `status`: `'submitted'` (or `'draft'`).
    - `submitted_at`: Current UTC timestamp.
  - Logs `audit_events` record.

### Step 6 — Server-Verified Payment Confirmation (If Applicable)
- **Condition**: Only if the selected program has `price_paise > 0`. If `price_paise === 0` (sponsored/free), enrollment is handled through review approval directly.
- **Endpoints**:
  - `POST /api/payments/create-order` (Proposed).
  - `POST /api/payments/verify-webhook` (Proposed).
- **Security & Integrity Rules**:
  1. **Zero Client Trust**: The frontend **never** tells the backend what amount was paid or what program was purchased.
  2. **Order Creation**:
     - Backend queries `internship_programs` for the canonical `price_paise`.
     - Calls payment gateway (Razorpay) API from Worker with server-side secrets.
     - Stores `payment_orders` record (`status = 'created'`).
     - Returns `gateway_order_id` to client checkout modal.
  3. **Verification**:
     - Client completes checkout and receives gateway payment ID & signature.
     - Webhook or verification endpoint verifies cryptographic HMAC-SHA256 signature using `RAZORPAY_KEY_SECRET`.
     - Inserts record into `payment_records` (`status = 'captured'`).
     - Updates `payment_orders.status = 'paid'`.
     - Transitions `applications.status` from `'submitted'` to `'enrolled'`.
  4. **Strict Guardrails**:
     - No payments can be initiated without approved merchant credentials.
     - No simulated payments in production.

### Step 7 — Applicant Views Application Status
- **User Action**: Applicant logs into their dashboard to monitor the progress of their application, submitted tasks, and review feedback.
- **Endpoint**: `GET /api/applications/me` (Proposed).
- **Backend Behavior**:
  - Queries `applications` filtered by `user_id = session.user.id`.
  - Returns current status:
    - `draft`: Application started but not finalized.
    - `submitted`: Received, awaiting review.
    - `under_review`: Under mentor or admissions evaluation.
    - `approved`: Accepted, awaiting enrollment/onboarding.
    - `rejected`: Application declined (with optional structured reason).
    - `enrolled`: Confirmed participant in the internship program.
    - `completed`: Successfully completed all required program tasks.
    - `withdrawn`: Withdrawn by applicant.
  - Returns associated program title, duration, submission date, and assigned tasks.

---

## 3. Clear Separation: Implemented vs. Proposed Endpoints

### Currently Implemented & Tested (Phase 24)
- `GET /api/health` — System status.
- `GET /api` — Endpoint catalog.
- `POST /api/auth/register` — Intern account creation (`pending_verification`).
- `POST /api/auth/login` — Authentication with session cookie.
- `POST /api/auth/logout` — Session revocation and cookie clearing.
- `POST /api/auth/forgot-password` — Password reset initiation (503 when email unconfigured).
- `POST /api/auth/reset-password` — Password reset completion (single-use token).
- `GET /api/user/me` — Authenticated profile retrieval.
- `GET /api/admin/users` — Role-gated admin user management.

### Proposed / Planned Endpoints (Phase 25+)
- `GET /api/auth/verify-email` — Email token confirmation.
- `GET /api/programs` — Public listing of active internship programs.
- `GET /api/programs/:slug` — Program details, syllabus, and requirements.
- `POST /api/applications` — Submit internship application.
- `GET /api/applications/me` — Retrieve current applicant's applications.
- `POST /api/applications/:id/withdraw` — Withdraw submitted application.
- `POST /api/payments/create-order` — Server-controlled checkout order generation.
- `POST /api/payments/verify` — HMAC signature verification for client callback.
- `POST /api/payments/webhook` — Razorpay webhook handler for server-to-server confirmation.
- `GET /api/submissions` & `POST /api/submissions` — Task submission upload & tracking.
- `GET /api/certificates/verify/:code` — Public certificate verification.

---

## 4. Absolute Policy Safeguards & Disclaimers
1. **No Invented Financial Terms**: Neither code nor documentation shall state arbitrary fees (e.g., "₹2,999" or "₹4,999") without written business authorization.
2. **No Invented Guarantees**: Nexora Nexus does not promise 100% placement, stipends, or unverified job offers.
3. **No Unearned Certificates**: Certificates are strictly gated behind `completion_approvals` table, requiring all mandatory tasks to be scored and approved by an authorized mentor or admin.
4. **No Premature Form Activation**: The public form on `internships.html` must remain in its current validated client-side state until the full backend application and payment verification pipeline is verified and authorized.
