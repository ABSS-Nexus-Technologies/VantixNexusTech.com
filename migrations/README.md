# Nexora Nexus — D1 Database Architecture & Migration Guide

## Overview

Nexora Nexus uses Cloudflare D1 (serverless SQLite at the edge) for ACID-compliant, low-latency relational persistence. This directory contains sequential, idempotent SQL migrations.

---

## 1. Schema Tables & Relationships

| Table | Purpose | Security & Integrity Rules |
| :--- | :--- | :--- |
| `users` | Accounts, roles (`intern`, `mentor`, `reviewer`, `admin`), status | Case-insensitive unique emails; PBKDF2 hashes with per-user salt. No public admin self-registration. |
| `user_sessions` | Server-side active sessions | Token hashes with strict expiry (`expires_at`) and revocation tracking (`revoked_at`). |
| `intern_profiles` | Applicant personal & education details | Linked 1:1 to `users`. Cascades on user deletion. |
| `internship_programs` | Available training tracks | Server-controlled pricing in integer paise (`price_paise`). Never trust client prices. |
| `applications` | Program applications | Unique per `(user_id, program_id)`. Private R2 object key stored for resume (`resume_r2_key`), never public URLs. |
| `payment_orders` | Pre-checkout orders | Integer paise amounts (`amount_paise`). Unique `gateway_order_id`. |
| `payment_records` | Captured gateway transactions | Verified Razorpay signatures; no raw cardholder, UPI PIN, or credential storage. |
| `tasks` | Structured curriculum modules | Ordered tasks per program; mandatory flag. |
| `submissions` | Intern project submissions | Unique attempt tracking; links to GitHub repos, demos, and private R2 assets. |
| `reviews` | Mentor evaluation & grading | Strict verdicts (`approved`, `revision_requested`, `rejected`). |
| `completion_approvals` | Official administrative completion sign-off | Enforces `all_tasks_verified = 1`. Required prerequisite for certificate generation. |
| `certificates` | Issued credentials & verification codes | Unique `certificate_code` for public verification; strictly foreign-keyed to `completion_approvals`. Supports revocation. |
| `audit_events` | Immutable security audit trail | Records security and financial events without logging sensitive credentials. |

---

## 2. Core Security & Design Principles

1. **Monetary Precision**: All currency amounts are stored in **integer paise** (e.g. ₹4,999.00 = `499900`). Float types are forbidden to eliminate rounding errors.
2. **Zero Payment Credential Storage**: Only gateway transaction references and verified signature hashes are stored. We never store credit card numbers, CVVs, UPI PINs, or bank credentials.
3. **Merit-Gated Certificates**: Certificates **cannot** be issued merely because a payment succeeded. A certificate strictly requires an approved record in `completion_approvals`, confirming 100% mandatory task verification.
4. **Idempotence**: All migrations use `IF NOT EXISTS` constructs so they can be safely re-run during automated CI/CD checks without wiping or corrupting existing records.
5. **Private R2 Storage**: Resumes, submissions, and certificate PDFs use opaque object keys (e.g. `resumes/uuid.pdf`), served exclusively through authenticated Worker endpoints.

---

## 3. Migration Instructions

### Prerequisites
- Cloudflare Wrangler CLI v4 (`npx wrangler`)
- Cloudflare account with D1 enabled

### Step A: Create D1 Database (When ready to provision)
Run in terminal:
```bash
npx wrangler d1 create nexora-nexus-db
```
This output provides your database UUID and the binding snippet:
```toml
[[d1_databases]]
binding = "DB"
database_name = "nexora-nexus-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```
Paste this into `wrangler.toml`.

### Step B: Apply Migrations Locally (for local development & tests)
```bash
# Execute migration against local SQLite simulator
npx wrangler d1 execute nexora-nexus-db --local --file=./migrations/0001_initial_schema.sql

# Or using wrangler migration runner:
npx wrangler d1 migrations apply nexora-nexus-db --local
```

### Step C: Apply Migrations to Production (Remote D1)
```bash
# Verify pending migrations
npx wrangler d1 migrations list nexora-nexus-db --remote

# Apply migrations
npx wrangler d1 migrations apply nexora-nexus-db --remote
```

### Step D: Verification Query
```bash
npx wrangler d1 execute nexora-nexus-db --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```
