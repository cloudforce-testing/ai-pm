CREATE TABLE IF NOT EXISTS docs (
  coll       TEXT NOT NULL,
  id         TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (coll, id)
);
