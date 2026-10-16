-- ==============================================================================
-- Nexora Nexus — Phase 33 Email Verification Schema
-- Migration: 0002_email_verifications.sql
--
-- Dialect: Cloudflare D1 (SQLite)
-- Rules:
-- 1. Store only a SHA-256 cryptographic hash of verification tokens.
-- 2. 24-hour expiration window.
-- 3. Tokens are single-use (tracked via used_at).
-- 4. Linked to users(id) with ON DELETE CASCADE.
-- 5. Fully idempotent (safe to run repeatedly with IF NOT EXISTS).
-- ==============================================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------------------
-- Email Verification Tokens
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires ON email_verifications(expires_at);
