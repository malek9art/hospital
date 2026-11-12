-- Serializes construction of the tamper-evident audit hash chain.
CREATE TABLE audit_chain_state (
  id         integer PRIMARY KEY CHECK (id = 1),
  last_hash  text NOT NULL,
  last_id    bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO audit_chain_state (id, last_hash) VALUES (1, repeat('0', 64));
GRANT SELECT, UPDATE ON audit_chain_state TO hms_app;
