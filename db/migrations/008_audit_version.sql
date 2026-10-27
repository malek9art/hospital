-- The audit hash canonicalisation is versioned so the algorithm can evolve
-- without silently invalidating existing chains.
ALTER TABLE audit_log ADD COLUMN hash_version smallint NOT NULL DEFAULT 1;
