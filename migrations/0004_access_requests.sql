-- 参加の依頼: はじめての人がGoogleでログインすると届き、管理者か記録係が許可する
CREATE TABLE IF NOT EXISTS access_requests (
  sub TEXT PRIMARY KEY,            -- Googleアカウントごとに変わらない番号
  email TEXT,
  name TEXT,                       -- Googleアカウントの名前
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / rejected
  requested_at TEXT DEFAULT (datetime('now'))
);
