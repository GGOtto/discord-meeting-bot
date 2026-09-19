PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meeting_series (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  title TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  voice_channel_id TEXT NOT NULL,
  announcement_channel_id TEXT NOT NULL,
  notify_role_id TEXT,
  timezone TEXT NOT NULL,
  local_time TEXT NOT NULL,
  first_date TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK(frequency IN ('once','daily','weekly','monthly')),
  interval_count INTEGER NOT NULL DEFAULT 1,
  weekdays_json TEXT NOT NULL DEFAULT '[]',
  month_day INTEGER,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  notification_preset TEXT NOT NULL DEFAULT 'balanced',
  ends_on TEXT,
  occurrence_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_occurrences (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES meeting_series(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  announcement_channel_id TEXT NOT NULL,
  announcement_message_id TEXT,
  voice_channel_id TEXT NOT NULL,
  notify_role_id TEXT,
  notification_preset TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_occurrences_schedule
ON meeting_occurrences(status, starts_at);

CREATE TABLE IF NOT EXISTS agenda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meeting_occurrences(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rsvps (
  meeting_id TEXT NOT NULL REFERENCES meeting_occurrences(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  response TEXT NOT NULL CHECK(response IN ('going','maybe','no')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS sent_notifications (
  meeting_id TEXT NOT NULL REFERENCES meeting_occurrences(id) ON DELETE CASCADE,
  notification_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, notification_key)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('channel','dm','important','off')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS meeting_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meeting_drafts_owner
ON meeting_drafts(user_id, guild_id);
