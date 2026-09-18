-- Phase 3: SOC approval_events + playbook_executions tables
-- All approval decisions are append-only (never update/delete).

CREATE TABLE approval_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(id),
  action_key    TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  decision      TEXT NOT NULL,
  decided_by    TEXT NOT NULL,
  decided_at    TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL,
  rationale     TEXT,
  evidence      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_decision CHECK (decision IN (
    'auto-approved', 'manually-approved', 'denied', 'escalated', 'blocked', 'timed-out'
  ))
);

CREATE INDEX idx_approval_events_job_id ON approval_events(job_id);
CREATE INDEX idx_approval_events_decided_at ON approval_events(decided_at DESC);
CREATE INDEX idx_approval_events_decision ON approval_events(decision);

-- Prevent UPDATE/DELETE on approval_events (append-only enforcement via trigger)
CREATE OR REPLACE FUNCTION prevent_approval_event_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'approval_events table is append-only: UPDATE and DELETE are prohibited';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_approval_events_no_update
  BEFORE UPDATE ON approval_events
  FOR EACH ROW EXECUTE FUNCTION prevent_approval_event_modification();

CREATE TRIGGER trg_approval_events_no_delete
  BEFORE DELETE ON approval_events
  FOR EACH ROW EXECUTE FUNCTION prevent_approval_event_modification();

-- Playbook executions
CREATE TABLE playbook_executions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL REFERENCES jobs(id),
  playbook_id            TEXT NOT NULL,
  status                 TEXT NOT NULL,
  steps                  JSONB NOT NULL DEFAULT '[]',
  total_affected_entities INT NOT NULL DEFAULT 0,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT valid_playbook_status CHECK (status IN (
    'running', 'completed', 'failed', 'rolled_back', 'escalated'
  ))
);

CREATE INDEX idx_playbook_executions_job_id ON playbook_executions(job_id);
CREATE INDEX idx_playbook_executions_status ON playbook_executions(status);
CREATE INDEX idx_playbook_executions_playbook_id ON playbook_executions(playbook_id);

-- Extend jobs status CHECK to include new SOC states
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE jobs ADD CONSTRAINT valid_status CHECK (status IN (
  'rejected', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled',
  'action_pending', 'action_executing'
));
