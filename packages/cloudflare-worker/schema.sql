-- LINE Memo Sync 台帳。メモ本文は持たない。
-- 適用: wrangler d1 execute line-memo-sync-ledger --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_message_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  stats_opt_in INTEGER NOT NULL DEFAULT 0
);

-- 本人がオンにした場合だけ入る、日付ごとの種類別件数
CREATE TABLE IF NOT EXISTS category_stats (
  line_user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  task INTEGER NOT NULL DEFAULT 0,
  idea INTEGER NOT NULL DEFAULT 0,
  link INTEGER NOT NULL DEFAULT 0,
  memo INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (line_user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_category_stats_date ON category_stats (date);
