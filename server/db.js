// SQLite 数据层：媒体库、节目单、时段计划、管理员账户
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'data.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 媒体库：主库固定为服务端 media 目录，其余为后台手工添加的外部文件夹
CREATE TABLE IF NOT EXISTS libraries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  path       TEXT NOT NULL UNIQUE,
  is_main    INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL UNIQUE,
  orig_name   TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('VIDEO','IMAGE')),
  size        INTEGER NOT NULL,
  library_id  INTEGER REFERENCES libraries(id),
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

-- 直播源（HLS/m3u8），时段节目单可通过 {liveId} 引用
CREATE TABLE IF NOT EXISTS live_streams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  url        TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
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

// 轻量迁移：老数据库补列，避免升级时要求手工改库
const mediaColumns = db.prepare('PRAGMA table_info(media)').all().map((column) => column.name);
if (!mediaColumns.includes('source_path')) {
  db.exec('ALTER TABLE media ADD COLUMN source_path TEXT');
}
if (!mediaColumns.includes('library_id')) {
  db.exec('ALTER TABLE media ADD COLUMN library_id INTEGER REFERENCES libraries(id)');
}

/**
 * 确保主媒体库（服务端 media 目录）存在，并把早期没有归属的媒体挂到主库上。
 * @param {string} mediaDir 服务端 media 目录的绝对路径
 * @returns {number} 主媒体库 id
 */
function ensureMainLibrary(mediaDir) {
  let row = db.prepare('SELECT id FROM libraries WHERE is_main = 1').get();
  if (!row) {
    row = db.prepare('SELECT id FROM libraries WHERE path = ?').get(mediaDir);
    if (row) {
      db.prepare('UPDATE libraries SET is_main = 1 WHERE id = ?').run(row.id);
    } else {
      const info = db.prepare(
        "INSERT INTO libraries (name, path, is_main) VALUES ('主媒体库', ?, 1)"
      ).run(mediaDir);
      row = { id: Number(info.lastInsertRowid) };
    }
  }
  db.prepare('UPDATE media SET library_id = ? WHERE library_id IS NULL').run(row.id);
  return row.id;
}

module.exports = db;
module.exports.ensureMainLibrary = ensureMainLibrary;
