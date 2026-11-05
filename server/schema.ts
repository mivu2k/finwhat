// Database schema (MySQL dialect). The server runs it as-is on MySQL; sqlDialect.translateSchema() adapts it for SQLite
// (server and phone). Kept as a .ts module so the phone's bundler can import it.
export const SCHEMA = `-- ExpenseChat MySQL schema. Applied idempotently at server start.
-- Permissions are enforced in server/app.ts (MySQL has no row-level security).

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(120),
  avatar_url TEXT,
  language ENUM('en','ur') NOT NULL DEFAULT 'en',
  default_currency CHAR(3) NOT NULL DEFAULT 'PKR',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(80) NOT NULL,
  base_currency CHAR(3) NOT NULL DEFAULT 'PKR',
  created_by CHAR(36) NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('admin','member') NOT NULL DEFAULT 'member',
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS categories (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  UNIQUE (workspace_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  workspace_id CHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description TEXT,
  approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  created_by CHAR(36) NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('owner','approver','member','viewer') NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS threads (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  channel_id CHAR(36) NOT NULL,
  created_by CHAR(36) NOT NULL,
  assigned_to CHAR(36) NULL,
  status ENUM('draft','submitted','under_review','approved','rejected','needs_info','unpaid','paid','closed') NOT NULL DEFAULT 'draft',
  source_type ENUM('form','voice','photo') NOT NULL DEFAULT 'form',
  title VARCHAR(200),
  amount DECIMAL(14,2) CHECK (amount >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'PKR',
  category_id CHAR(36) NULL,
  vendor VARCHAR(200),
  expense_date DATE,
  payment_method VARCHAR(30),
  tag VARCHAR(80),
  notes TEXT,
  due_date DATE,
  line_items JSON NULL,
  closed_at TIMESTAMP NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (channel_id, created_at),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL,
  storage_path VARCHAR(500) NOT NULL UNIQUE,
  file_name VARCHAR(255),
  mime VARCHAR(100),
  size_bytes BIGINT,
  sha256 CHAR(64),
  uploaded_by CHAR(36) NOT NULL REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS thread_messages (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL,
  author_id CHAR(36) NULL,
  type ENUM('text','system','image','voice','file') NOT NULL DEFAULT 'text',
  body TEXT,
  attachment_id CHAR(36) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (thread_id, created_at),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL UNIQUE,
  workspace_id CHAR(36) NOT NULL,
  channel_id CHAR(36) NOT NULL,
  entry_date DATE NOT NULL,
  category_id CHAR(36) NULL,
  amount DECIMAL(14,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  fx_rate DECIMAL(18,8) NOT NULL DEFAULT 1,
  base_amount DECIMAL(14,2) AS (ROUND(amount * fx_rate, 2)) STORED,
  payer CHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (workspace_id, entry_date),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  channel_id CHAR(36),
  table_name VARCHAR(40) NOT NULL,
  row_id VARCHAR(80) NOT NULL,
  action VARCHAR(20) NOT NULL,
  actor CHAR(36),
  old_row JSON,
  new_row JSON,
  at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (channel_id, at)
);

-- ponytail: audit_logs is append-only by convention (the API never updates/deletes it). DB-level triggers need
-- SUPER or log_bin_trust_function_creators=1 on binlog-enabled MySQL; add them (or REVOKE UPDATE, DELETE) when ops allows.

-- ───── phase 2: voice / photo AI ─────
CREATE TABLE IF NOT EXISTS transcripts (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL,
  attachment_id CHAR(36) NOT NULL,
  text TEXT NOT NULL,
  language VARCHAR(10),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS extractions (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL,
  fields JSON NOT NULL,                     -- { field: { value, confidence 0..1 } }
  line_items JSON,
  model VARCHAR(60),
  created_by CHAR(36),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (thread_id, created_at),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

-- ───── phase 3: approvals, payments, notifications ─────
CREATE TABLE IF NOT EXISTS approvals (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL,
  approver_id CHAR(36) NOT NULL,
  role VARCHAR(20) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  method ENUM('cash','bank_transfer','card','wallet') NOT NULL,
  reference VARCHAR(120),
  paid_on DATE NOT NULL,
  attachment_id CHAR(36) NULL,
  recorded_by CHAR(36) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  thread_id CHAR(36),
  kind VARCHAR(30) NOT NULL,               -- mention | approval_request | status | comment | overdue
  body VARCHAR(500) NOT NULL,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (user_id, read_at, created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

-- what an advance holder accounted for: spending with evidence, or cash handed back
CREATE TABLE IF NOT EXISTS settlements (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  thread_id CHAR(36) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  description VARCHAR(200) NOT NULL,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  spent_on DATE NOT NULL,
  attachment_id CHAR(36) NULL,
  created_by CHAR(36) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (thread_id, created_at),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS push_tokens (
  token VARCHAR(255) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_resets (
  user_id CHAR(36) PRIMARY KEY,
  code_hash VARCHAR(128) NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invites (
  token VARCHAR(40) PRIMARY KEY,
  channel_id CHAR(36) NOT NULL,
  role VARCHAR(20) NOT NULL,
  created_by CHAR(36) NOT NULL,
  expires_on DATE NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS budgets (
  id CHAR(36) PRIMARY KEY,
  workspace_id CHAR(36) NOT NULL,
  scope VARCHAR(20) NOT NULL,
  target VARCHAR(120) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delegations (
  channel_id CHAR(36) NOT NULL,
  from_user CHAR(36) NOT NULL,
  to_user CHAR(36) NOT NULL,
  until_date DATE NOT NULL,
  PRIMARY KEY (channel_id, from_user),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS templates (
  id CHAR(36) PRIMARY KEY,
  channel_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  name VARCHAR(80) NOT NULL,
  data JSON NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recurring (
  id CHAR(36) PRIMARY KEY,
  channel_id CHAR(36) NOT NULL,
  created_by CHAR(36) NOT NULL,
  title VARCHAR(200),
  data JSON NOT NULL,
  day_of_month INT NOT NULL,
  next_run DATE NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_state (
  k VARCHAR(40) PRIMARY KEY,
  v VARCHAR(100)
);

-- AI chosen per workspace: cloud API or a local model (Ollama, LM Studio...). Keys are encrypted.
CREATE TABLE IF NOT EXISTS ai_settings (
  workspace_id CHAR(36) PRIMARY KEY,
  extract_provider VARCHAR(20) NOT NULL DEFAULT 'none',
  extract_url VARCHAR(300),
  extract_model VARCHAR(120),
  extract_key TEXT,
  transcribe_provider VARCHAR(20) NOT NULL DEFAULT 'none',
  transcribe_url VARCHAR(300),
  transcribe_model VARCHAR(120),
  transcribe_key TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- record_scope = 'selected': whose records this member may see
CREATE TABLE IF NOT EXISTS scope_users (
  channel_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  can_see CHAR(36) NOT NULL,
  PRIMARY KEY (channel_id, user_id, can_see),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
`;

/** Columns added after the first release; each runs once ("column exists" errors are ignored). */
export const MIGRATIONS = [
    "ALTER TABLE channel_members ADD COLUMN record_scope VARCHAR(20) NOT NULL DEFAULT 'all'",
    'ALTER TABLE channels ADD COLUMN parent_id CHAR(36) NULL',
    'ALTER TABLE channels ADD COLUMN receipt_required_above DECIMAL(14,2) NULL',
    'ALTER TABLE channels ADD COLUMN block_new_advance BOOLEAN NOT NULL DEFAULT FALSE',
    'ALTER TABLE channel_members ADD COLUMN monthly_limit DECIMAL(14,2) NULL',
    "ALTER TABLE settlements ADD COLUMN review_status VARCHAR(20) NOT NULL DEFAULT 'pending'",
    'ALTER TABLE settlements ADD COLUMN review_note VARCHAR(200) NULL',
    "ALTER TABLE threads ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'expense'",
    'ALTER TABLE channels ADD COLUMN owner_approval_limit DECIMAL(14,2) NULL',
    'ALTER TABLE threads ADD COLUMN fx_rate DECIMAL(18,8) NULL',
    'ALTER TABLE thread_messages ADD COLUMN reply_to CHAR(36) NULL',
    'ALTER TABLE thread_messages ADD COLUMN mentions JSON NULL',
    'ALTER TABLE thread_messages ADD COLUMN reactions JSON NULL',
    'ALTER TABLE threads ADD COLUMN line_items JSON NULL',
];
