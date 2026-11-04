// SQLite 数据层：媒体库、草稿节目单、时段计划、已发布版本、终端配对、管理员账户
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'data.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL UNIQUE,
  orig_name   TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('VIDEO','IMAGE')),
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS program_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id     INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  duration_sec INTEGER
);

CREATE TABLE IF NOT EXISTS schedules (
  id           TEXT PRIMARY KEY,
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   INTEGER NOT NULL CHECK (end_minute   BETWEEN 0 AND 1439),
  enabled      INTEGER NOT NULL DEFAULT 1,
  items_json   TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS versions (
  content_version INTEGER PRIMARY KEY,
  manifest_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS terminals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  code       TEXT UNIQUE,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 管理员账户（单用户）
CREATE TABLE IF NOT EXISTS admin_user (
  username    TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,         -- scrypt 输出 (hex)
  salt        TEXT NOT NULL,            -- scrypt salt (hex)
  locked_until INTEGER NOT NULL DEFAULT 0,  -- Unix 秒；0=未锁
  failures    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
