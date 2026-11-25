-- 星宙 · D1 建表
-- Cloudflare → Storage & Databases → D1 → 你的库 → Console → 整段粘贴 → Execute

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    UNIQUE NOT NULL,
  name          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER,
  role       TEXT    NOT NULL DEFAULT 'visitor',  -- visitor | user | admin
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wishes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_token TEXT,                              -- 匿名设备也能认回自己写的
  user_id     INTEGER,
  text        TEXT    NOT NULL,                  -- 原样保存，含原站的零宽编号前缀
  name        TEXT,
  photo       TEXT,
  status      TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT    NOT NULL,
  author     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wishes_status ON wishes(status, id);
CREATE INDEX IF NOT EXISTS idx_wishes_owner  ON wishes(owner_token, id);
CREATE INDEX IF NOT EXISTS idx_wishes_user   ON wishes(user_id);
CREATE INDEX IF NOT EXISTS idx_ann_time      ON announcements(created_at DESC);

-- 如果你之前已经按旧版建过表，只需补这一段：
-- CREATE TABLE IF NOT EXISTS announcements (
--   id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
--   author TEXT, created_at INTEGER NOT NULL
-- );
