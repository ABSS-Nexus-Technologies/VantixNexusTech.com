-- ==============================================================================
-- Nexora Nexus — Phase 21 Initial D1 Database Schema
-- Migration: 0001_initial_schema.sql
--
-- Dialect: Cloudflare D1 (SQLite)
-- Rules:
-- 1. All monetary values stored as integer paise (1 INR = 100 paise).
-- 2. Never store raw cards, CVVs, UPI PINs, bank passwords or payment secrets.
-- 3. Passwords stored as PBKDF2-HMAC-SHA256 hashes with unique salt.
-- 4. Server-controlled program pricing in integer paise.
-- 5. Certificates strictly require an approved completion record.
-- 6. Fully idempotent (safe to run repeatedly with IF NOT EXISTS).
-- ==============================================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------------------
-- 1. Users & Roles
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('intern', 'mentor', 'reviewer', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'pending_verification', 'deactivated')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- ------------------------------------------------------------------------------
-- 2. User Sessions (Server-side Session Handling with Expiry and Revocation)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT DEFAULT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- ------------------------------------------------------------------------------
-- 3. Intern Profiles
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intern_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    phone TEXT,
    college TEXT,
    graduation_year INTEGER,
    linkedin_url TEXT,
    github_url TEXT,
    portfolio_url TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_intern_profiles_user ON intern_profiles(user_id);

-- ------------------------------------------------------------------------------
-- 4. Internship Programs (Server-Controlled INR Pricing)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS internship_programs (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    duration_weeks INTEGER NOT NULL CHECK (duration_weeks > 0),
    mode TEXT NOT NULL DEFAULT 'remote' CHECK (mode IN ('remote', 'hybrid', 'onsite')),
    price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
    currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    max_seats INTEGER DEFAULT NULL CHECK (max_seats IS NULL OR max_seats > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_internship_programs_slug ON internship_programs(slug);
CREATE INDEX IF NOT EXISTS idx_internship_programs_active ON internship_programs(is_active);

-- ------------------------------------------------------------------------------
-- 5. Applications
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    program_id TEXT NOT NULL REFERENCES internship_programs(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'enrolled', 'completed', 'withdrawn')),
    statement_of_purpose TEXT,
    resume_r2_key TEXT,
    submitted_at TEXT,
    reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    rejection_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_application_user_program UNIQUE (user_id, program_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_applications_program ON applications(program_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

-- ------------------------------------------------------------------------------
-- 6. Payment Orders (Pre-Checkout / Gateway Order State)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    gateway TEXT NOT NULL DEFAULT 'razorpay' CHECK (gateway IN ('razorpay', 'manual_offline', 'test')),
    gateway_order_id TEXT UNIQUE,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'attempted', 'paid', 'failed', 'cancelled', 'expired')),
    notes_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_app ON payment_orders(application_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_gateway_order ON payment_orders(gateway_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);

-- ------------------------------------------------------------------------------
-- 7. Payment Records (Verified Captured Payments & Audits)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_records (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
    gateway_payment_id TEXT UNIQUE,
    gateway_signature TEXT,
    amount_paid_paise INTEGER NOT NULL CHECK (amount_paid_paise > 0),
    currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    status TEXT NOT NULL CHECK (status IN ('captured', 'failed', 'refunded', 'disputed')),
    payment_method TEXT,
    error_code TEXT,
    error_description TEXT,
    captured_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_records_order ON payment_records(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_gateway_payment ON payment_records(gateway_payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_status ON payment_records(status);

-- ------------------------------------------------------------------------------
-- 8. Program Tasks
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES internship_programs(id) ON DELETE CASCADE,
    task_number INTEGER NOT NULL CHECK (task_number > 0),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT,
    max_score INTEGER NOT NULL DEFAULT 100 CHECK (max_score > 0),
    is_mandatory INTEGER NOT NULL DEFAULT 1 CHECK (is_mandatory IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CONSTRAINT uq_task_program_number UNIQUE (program_id, task_number)
);

CREATE INDEX IF NOT EXISTS idx_tasks_program ON tasks(program_id);

-- ------------------------------------------------------------------------------
-- 9. Task Submissions
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
    submission_repo_url TEXT,
    submission_demo_url TEXT,
    submission_r2_key TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'accepted', 'needs_revision', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_application ON submissions(application_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

-- ------------------------------------------------------------------------------
-- 10. Reviews (Mentor Evaluations)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    score INTEGER CHECK (score IS NULL OR score >= 0),
    feedback TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('approved', 'revision_requested', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_submission ON reviews(submission_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews(reviewer_id);

-- ------------------------------------------------------------------------------
-- 11. Completion Approvals (Prerequisite for Certificate Issuance)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS completion_approvals (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE RESTRICT,
    approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approval_notes TEXT,
    all_tasks_verified INTEGER NOT NULL CHECK (all_tasks_verified = 1),
    approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_completion_approvals_app ON completion_approvals(application_id);
CREATE INDEX IF NOT EXISTS idx_completion_approvals_approver ON completion_approvals(approved_by);

-- ------------------------------------------------------------------------------
-- 12. Certificates (Public Verification & Revocation Tracking)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS certificates (
    id TEXT PRIMARY KEY,
    certificate_code TEXT NOT NULL UNIQUE,
    application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    program_id TEXT NOT NULL REFERENCES internship_programs(id) ON DELETE RESTRICT,
    completion_approval_id TEXT NOT NULL UNIQUE REFERENCES completion_approvals(id) ON DELETE RESTRICT,
    recipient_name TEXT NOT NULL,
    program_title TEXT NOT NULL,
    issue_date TEXT NOT NULL,
    pdf_r2_key TEXT NOT NULL,
    is_revoked INTEGER NOT NULL DEFAULT 0 CHECK (is_revoked IN (0, 1)),
    revocation_reason TEXT DEFAULT NULL,
    revoked_at TEXT DEFAULT NULL,
    revoked_by TEXT DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_certificates_code ON certificates(certificate_code);
CREATE INDEX IF NOT EXISTS idx_certificates_user ON certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_certificates_program ON certificates(program_id);
CREATE INDEX IF NOT EXISTS idx_certificates_revoked ON certificates(is_revoked);

-- ------------------------------------------------------------------------------
-- 13. Audit Events (Immutable Security Log)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_throttle ON audit_events(action, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_ip_throttle ON audit_events(action, ip_address, created_at);

-- ------------------------------------------------------------------------------
-- 14. Password Resets (Secure Single-Use Token Hashes with Expiry)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);

