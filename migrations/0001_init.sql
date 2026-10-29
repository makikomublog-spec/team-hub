-- チーム管理ツール(配布版)のデータベース設計
-- 1つの表 = スプレッドシートの1シートのイメージ

-- プロジェクト(このツール1つ = 1プロジェクト。最初の設定画面で作る)
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  short_name TEXT DEFAULT '',   -- 画面に出す短いチーム名
  start_date TEXT,              -- 'YYYY-MM-DD'
  end_date TEXT,
  overview TEXT DEFAULT '',     -- まとめページ: 目的
  concept TEXT DEFAULT '',      -- まとめページ: コンセプト
  created_at TEXT DEFAULT (datetime('now'))
);

-- メンバー名簿(自己紹介カードの項目つき)
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,              -- 名簿での呼び名(出欠・タスクの担当に使う)
  display_name TEXT DEFAULT '',    -- 名前(表示名)
  role TEXT DEFAULT '',            -- 役割・関わり方
  profile_url TEXT DEFAULT '',     -- プロフィールのリンク
  region TEXT DEFAULT '',          -- 住んでいる地域
  motivation TEXT DEFAULT '',      -- 参加したきっかけ・楽しみにしていること
  can_help TEXT DEFAULT '',        -- 手伝えそうなこと
  want_to_do TEXT DEFAULT '',      -- やってみたいこと
  involvement TEXT DEFAULT '',     -- 希望する関わり方
  message TEXT DEFAULT '',         -- ひとこと
  duty_plan TEXT DEFAULT '',       -- 担当案
  duty_fixed TEXT DEFAULT '',      -- 確定担当
  is_recorder INTEGER DEFAULT 0,   -- 1 = 記録係(議事録の作成・メンバーの招待ができる)
  is_owner INTEGER DEFAULT 0,      -- 1 = 管理者(最初に設定した人。名簿から外せない)
  active INTEGER DEFAULT 1         -- 0 = 名簿から外した(過去の議事録の名前は残す)
);

-- ログイン(名簿の1人 = 1アカウント)。パスワードはそのまま保存せず、復元できない形にして持つ
CREATE TABLE IF NOT EXISTS accounts (
  member_id INTEGER PRIMARY KEY REFERENCES members(id),
  login_id TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  fail_count INTEGER DEFAULT 0,    -- 続けて間違えた回数(10回で15分ロック)
  fail_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 招待リンク・パスワード再設定リンク(7日間有効・1回だけ使える)
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  created_by TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- ログイン中の状態(30日間)
CREATE TABLE IF NOT EXISTS login_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  expires_at TEXT NOT NULL
);

-- 会議(1回の会議 = 1行。議事録の本文もここに持つ)
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  held_at TEXT NOT NULL,        -- 'YYYY-MM-DD HH:MM'
  ended_at TEXT,
  place TEXT DEFAULT '',
  facilitator TEXT DEFAULT '',
  agenda TEXT DEFAULT '',            -- 今回の議題
  summary TEXT DEFAULT '',           -- 要旨
  confirmations TEXT DEFAULT '',     -- 確認事項
  next_actions TEXT DEFAULT '',      -- 次回までにやること
  progress_note TEXT DEFAULT '',     -- プロジェクト進捗
  next_checks TEXT DEFAULT '',       -- 次回会議で確認すること
  body_html TEXT DEFAULT '',         -- 議事録の詳しい本文(PDF出力に使う)
  discussion TEXT DEFAULT '',        -- 「議論の内容」の元の文章(修正するときに使う)
  status TEXT NOT NULL DEFAULT 'draft',  -- draft / published
  draft_json TEXT,                   -- 作成途中(下書き)の入力内容
  created_by TEXT,
  published_at TEXT
);

-- 出欠
CREATE TABLE IF NOT EXISTS attendance (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  status TEXT NOT NULL,         -- present / listen / absent  (出席 / 聞き専 / 欠席)
  note TEXT DEFAULT '',
  PRIMARY KEY (meeting_id, member_id)
);

-- 情報源(要項・資料・企画書など)
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  year TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'latest', -- latest(最新) / reference(参考) / old(古い版)
  file_key TEXT,                     -- 保管場所(KV)のキー。ファイルがない情報源は空
  file_name TEXT,
  file_size INTEGER DEFAULT 0,
  mime TEXT,
  origin TEXT DEFAULT '',            -- 出典元(URLや入手先)
  text TEXT DEFAULT '',              -- 本文(PDFから抜き出した文字など。AIに渡す用)
  note TEXT DEFAULT '',
  uploaded_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- タスク
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  assignee_id INTEGER REFERENCES members(id),  -- 空なら担当未定
  start_date TEXT,              -- 空なら「日程未定」
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'todo',  -- todo / doing / done
  priority TEXT DEFAULT '',     -- 高 / 中 / 低
  meeting_id INTEGER REFERENCES meetings(id),  -- どの会議で決まったか
  source_id INTEGER REFERENCES sources(id),    -- どの情報源から作ったか
  note TEXT DEFAULT '',
  done_criteria TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by TEXT
);

-- 決定事項(累積)
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  meeting_id INTEGER REFERENCES meetings(id),
  content TEXT NOT NULL,
  decided_on TEXT
);

-- Q&A(累積)
CREATE TABLE IF NOT EXISTS qas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  meeting_id INTEGER REFERENCES meetings(id),
  source_id INTEGER REFERENCES sources(id),
  category TEXT DEFAULT '',
  question TEXT NOT NULL,
  answer TEXT DEFAULT '',       -- 空なら未回答
  asked_by TEXT DEFAULT ''
);

-- 検討中のこと(未解決の課題)
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  meeting_id INTEGER REFERENCES meetings(id),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open / resolved
  priority TEXT DEFAULT '',
  next_step TEXT DEFAULT '',
  done_criteria TEXT DEFAULT ''
);

-- カレンダーの節目(締切・本番など)
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  date TEXT NOT NULL,
  end_date TEXT,
  title TEXT NOT NULL,
  kind TEXT DEFAULT 'deadline'  -- deadline / event / meeting
);

-- 関連資料(リンクだけ)
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  url TEXT NOT NULL
);

-- 公式事項(資料から整理した、日付・金額・決まりごと)
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source_id INTEGER REFERENCES sources(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  page TEXT DEFAULT '',
  kind TEXT DEFAULT 'rule',          -- date / money / rule
  sort INTEGER DEFAULT 0
);

-- 版の違いのチェック結果
CREATE TABLE IF NOT EXISTS diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  base_source_id INTEGER REFERENCES sources(id),
  summary TEXT DEFAULT '',
  changes TEXT DEFAULT '[]',
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- チームの方向性
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  item TEXT NOT NULL,
  content TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);

-- 変更履歴(誰がいつ何を直したか)
CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  record_id INTEGER,
  action TEXT NOT NULL,         -- create / update / delete
  before_json TEXT,
  after_json TEXT,
  changed_by TEXT,
  changed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project_id, held_at);
