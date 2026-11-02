-- Googleログイン: ツールごとの設定と、Googleアカウントとメンバーの結びつき
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS google_accounts (
  sub TEXT PRIMARY KEY,            -- Googleアカウントごとに変わらない番号
  member_id INTEGER NOT NULL UNIQUE REFERENCES members(id),
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
