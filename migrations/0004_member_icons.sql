-- メンバーのキャラクターアイコン(画像は小さくしてから保存する)
CREATE TABLE IF NOT EXISTS member_icons (
  member_id INTEGER PRIMARY KEY REFERENCES members(id),
  mime TEXT NOT NULL,
  data TEXT NOT NULL,              -- 画像(base64)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 試しに入れた「参加の依頼」の表は使わなくなったので消す
DROP TABLE IF EXISTS access_requests;
