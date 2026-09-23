ALTER TABLE jobs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS execution_token TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS delivery_id TEXT;

-- Durable intents are committed with the state change, before contacting Redis or callbacks.
CREATE TABLE IF NOT EXISTS gateway_outbox (
  id TEXT PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('execution', 'callback')),
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_outbox_pending ON gateway_outbox(available_at) WHERE delivered_at IS NULL;
