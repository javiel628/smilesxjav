CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_id TEXT UNIQUE,
  phone_e164 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initializing','requesting_code','waiting_verification','connected','saved','failed','revoked')),
  pairing_code TEXT,
  encrypted_auth BYTEA,
  auth_iv BYTEA,
  auth_tag BYTEA,
  error_code TEXT,
  error_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_phone_active_unique ON sessions(phone_e164) WHERE status IN ('initializing','requesting_code','waiting_verification','connected','saved');
CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  desired_state TEXT NOT NULL DEFAULT 'stopped',
  worker_pid INTEGER,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id)
);
CREATE INDEX IF NOT EXISTS deployments_user_idx ON deployments(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS deployment_logs (
  id BIGSERIAL PRIMARY KEY,
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deployment_logs_idx ON deployment_logs(deployment_id, created_at DESC);
