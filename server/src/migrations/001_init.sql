-- inhousechannel content server, initial schema. Timestamps are ISO-8601 UTC text.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login    TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE sites (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  timezone      TEXT NOT NULL DEFAULT 'America/Barbados',
  logo_media_id INTEGER,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Who may see a site. Superadmins have no rows here; they see everything.
CREATE TABLE memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('admin','editor')),
  PRIMARY KEY (user_id, site_id)
);
CREATE INDEX memberships_site ON memberships(site_id);

CREATE TABLE media (
  id            INTEGER PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','audio','font')),
  name          TEXT NOT NULL,
  original_path TEXT NOT NULL,          -- as uploaded, kept
  path          TEXT,                   -- what players download (normalised for video/audio)
  mime          TEXT NOT NULL,
  size          INTEGER,
  width         INTEGER,
  height        INTEGER,
  duration_s    REAL,
  sha256        TEXT,
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','processing','failed')),
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX media_site ON media(site_id);

CREATE TABLE layouts (
  id         INTEGER PRIMARY KEY,
  site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  json       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX layouts_site ON layouts(site_id);

CREATE TABLE players (
  id                INTEGER PRIMARY KEY,
  site_id           INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  key_hash          TEXT NOT NULL UNIQUE,  -- sha256 hex of the bearer key
  key_tail          TEXT NOT NULL,         -- last 4 chars, shown in the UI to tell keys apart
  resolution        TEXT NOT NULL DEFAULT '1280x720',
  default_layout_id INTEGER REFERENCES layouts(id) ON DELETE SET NULL,
  output_json       TEXT,                  -- what the box reports (read-only mirror)
  version           TEXT,
  last_seen_at      TEXT,
  last_status_json  TEXT,
  thumbnail_path    TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX players_site ON players(site_id);

-- Overrides of a player's default layout. days_mask bit n = weekday n (0 = Sunday);
-- times are local "HH:MM" in the site's timezone, end < start means overnight; NULL = always.
CREATE TABLE schedules (
  id         INTEGER PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  layout_id  INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  priority   INTEGER NOT NULL DEFAULT 0,
  days_mask  INTEGER NOT NULL DEFAULT 127,
  start_time TEXT,
  end_time   TEXT,
  start_date TEXT,
  end_date   TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX schedules_player ON schedules(player_id);
