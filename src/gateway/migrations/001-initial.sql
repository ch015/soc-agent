-- Phase 1 Gateway: Initial schema
-- Jobs, tenants, and events tables

CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  api_key       TEXT UNIQUE NOT NULL,
  slack_team_id TEXT UNIQUE,
  config        JSONB NOT NULL DEFAULT '{}',
  quota         JSONB NOT NULL DEFAULT '{"maxConcurrentJobs": 5, "maxDailyJobs": 100}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  domain        TEXT NOT NULL CHECK (domain = 'soc'),
  status        TEXT NOT NULL DEFAULT 'queued',
  priority      INT NOT NULL DEFAULT 3,

  -- Input
  input         JSONB NOT NULL,
  callback      JSONB NOT NULL,

  -- Progress / Result
  progress      JSONB,
  result        JSONB,
  error         JSONB,

  -- Pending input (waiting state)
  pending_input JSONB,

  -- Metadata
  cost_usd      NUMERIC(10,4),
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,

  CONSTRAINT valid_status CHECK (status IN (
    'rejected', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'
  ))
);

CREATE INDEX idx_jobs_tenant_status ON jobs(tenant_id, status);
CREATE INDEX idx_jobs_domain_status ON jobs(domain, status);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- SSE event storage (supports Last-Event-ID reconnection)
CREATE TABLE job_events (
  id            BIGSERIAL PRIMARY KEY,
  job_id        UUID NOT NULL REFERENCES jobs(id),
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_job_events_job_id ON job_events(job_id, id);
