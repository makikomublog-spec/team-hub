-- 設置ページで作った人だけが管理者になるための、1回限りの印（本文ではなくハッシュを保存する）
CREATE TABLE IF NOT EXISTS setup_claim (code_hash TEXT NOT NULL);
