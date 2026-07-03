-- PlanJinji database schema (SQLite)

CREATE TABLE IF NOT EXISTS clients (
  id            TEXT PRIMARY KEY,          -- normalized from full name, e.g. dana_levi
  name          TEXT NOT NULL,
  goals         TEXT NOT NULL,
  frequency     INTEGER NOT NULL,          -- sessions per week (1-7)
  facilities    TEXT NOT NULL,             -- JSON array of equipment strings
  pin           TEXT,                      -- 4-digit login PIN (NULL = must set on next login)
  joined        TEXT NOT NULL,             -- ISO date
  progress_week INTEGER NOT NULL DEFAULT 0,-- 0-based; 5 means program complete
  progress_day  INTEGER NOT NULL DEFAULT 0 -- 0-based index of next workout
);

CREATE TABLE IF NOT EXISTS workout_days (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week      INTEGER NOT NULL,              -- 0..4
  day       INTEGER NOT NULL,              -- 0..frequency-1
  title     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (client_id, week, day)
);

CREATE TABLE IF NOT EXISTS exercises (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week      INTEGER NOT NULL,
  day       INTEGER NOT NULL,
  position  INTEGER NOT NULL,              -- order within the workout
  name      TEXT NOT NULL,
  sets      TEXT NOT NULL DEFAULT '',
  reps      TEXT NOT NULL DEFAULT '',
  weight    TEXT NOT NULL DEFAULT '',      -- target weight ("40kg", "RPE7", "bodyweight")
  rest      TEXT NOT NULL DEFAULT '90'     -- rest between sets, seconds
);

CREATE INDEX IF NOT EXISTS idx_exercises_slot ON exercises (client_id, week, day, position);

CREATE TABLE IF NOT EXISTS session_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id    TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,              -- ISO datetime
  week         INTEGER,                    -- 1-based, as shown to the user
  day          INTEGER,                    -- 1-based
  session_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_logs_client ON session_logs (client_id, id);

CREATE TABLE IF NOT EXISTS log_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id      INTEGER NOT NULL REFERENCES session_logs(id) ON DELETE CASCADE,
  exercise    TEXT NOT NULL,
  weight_used TEXT NOT NULL DEFAULT '',    -- what the athlete actually lifted
  comment     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,                  -- e.g. coach_pin
  value TEXT NOT NULL
);
