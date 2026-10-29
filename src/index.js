import { Hono } from "hono";
import { loadUser, login, startSession, endSession, sessionCookie, clearCookie, hashPassword, checkCredentials, createInvite, findInvite } from "./auth.js";

const app = new Hono();

// 今日の日付(日本時間) 'YYYY-MM-DD'
const todayJST = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// ---- よそのサイトからの書き込みを断る(画面と同じ場所からの操作だけ受け付ける) ----
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (c.req.method !== "GET" && origin && origin !== new URL(c.req.url).origin) return c.json({ error: "このページからは操作できません" }, 403);
  await next();
});

// ---- ログイン前に使うもの(最初の設定・ログイン・招待リンク) ----
const needsSetup = async (db) => !(await db.prepare("SELECT 1 FROM accounts LIMIT 1").first());

app.get("/api/auth/state", async (c) => c.json({ needsSetup: await needsSetup(c.env.DB) }));

// 最初の設定: まだ誰もいないときだけ、プロジェクトと管理者(＝記録係)を作る
app.post("/api/auth/setup", async (c) => {
  const db = c.env.DB, b = await c.req.json();
  if (!(await needsSetup(db))) return c.json({ error: "すでに設定済みです。ログインしてください" }, 400);
  const v = (k) => String(b[k] || "").trim();
  if (!v("project_name")) return c.json({ error: "プロジェクト名を入れてください" }, 400);
  if (!v("name")) return c.json({ error: "あなたの呼び名を入れてください" }, 400);
  const D = /^\d{4}-\d{2}-\d{2}$/;
  if (!D.test(v("start_date")) || !D.test(v("end_date")) || v("start_date") > v("end_date")) return c.json({ error: "期間（開始日〜終了日）を正しく入れてください" }, 400);
  const err = checkCredentials(v("login_id"), b.password);
  if (err) return c.json({ error: err }, 400);
  const hash = await hashPassword(b.password);
  const r = await db.prepare("INSERT INTO members (name, display_name, is_recorder, is_owner) VALUES (?, ?, 1, 1)").bind(v("name"), v("name")).run();
  const memberId = r.meta.last_row_id;
  await db.batch([
    db.prepare("INSERT INTO projects (name, short_name, start_date, end_date) VALUES (?, ?, ?, ?)")
      .bind(v("project_name"), v("short_name") || v("project_name"), v("start_date"), v("end_date")),
    db.prepare("INSERT INTO accounts (member_id, login_id, pass_hash) VALUES (?, ?, ?)").bind(memberId, v("login_id"), hash),
  ]);
  c.header("Set-Cookie", sessionCookie(await startSession(db, memberId), c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c) => {
  const db = c.env.DB, b = await c.req.json();
  const r = await login(db, String(b.login_id || "").trim(), String(b.password || ""));
  if (r.error) return c.json({ error: r.error }, 401);
  c.header("Set-Cookie", sessionCookie(await startSession(db, r.memberId), c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  await endSession(c.env.DB, c.req.raw);
  c.header("Set-Cookie", clearCookie());
  return c.json({ ok: true });
});

// 招待リンクを開いたとき: 誰あての招待か(すでにアカウントがあれば「パスワードの再設定」)
app.get("/api/auth/invite/:token", async (c) => {
  const inv = await findInvite(c.env.DB, c.req.param("token"));
  if (!inv || !inv.active) return c.json({ error: "このリンクは使えません（期限切れ・使用済み・まちがい）。記録係に新しいリンクをもらってください" }, 404);
  const p = await c.env.DB.prepare("SELECT name FROM projects ORDER BY id LIMIT 1").first();
  return c.json({ name: inv.name, loginId: inv.login_id || "", reset: !!inv.login_id, project: p?.name || "" });
});

app.post("/api/auth/invite/:token", async (c) => {
  const db = c.env.DB, b = await c.req.json();
  const inv = await findInvite(db, c.req.param("token"));
  if (!inv || !inv.active) return c.json({ error: "このリンクは使えません。記録係に新しいリンクをもらってください" }, 404);
  const loginId = inv.login_id || String(b.login_id || "").trim();
  const err = checkCredentials(loginId, b.password);
  if (err) return c.json({ error: err }, 400);
  const taken = await db.prepare("SELECT member_id FROM accounts WHERE login_id = ?").bind(loginId).first();
  if (taken && taken.member_id !== inv.member_id) return c.json({ error: "そのログインIDはほかの人が使っています。別のIDにしてください" }, 400);
  const hash = await hashPassword(b.password);
  await db.batch([
    db.prepare(`INSERT INTO accounts (member_id, login_id, pass_hash) VALUES (?, ?, ?)
      ON CONFLICT(member_id) DO UPDATE SET pass_hash = excluded.pass_hash, fail_count = 0, fail_at = NULL`).bind(inv.member_id, loginId, hash),
    db.prepare("UPDATE invites SET used_at = datetime('now') WHERE token_hash = ?").bind(inv.token_hash),
    db.prepare("DELETE FROM login_sessions WHERE member_id = ?").bind(inv.member_id), // パスワードを変えたら、ほかの端末のログインは切る
  ]);
  c.header("Set-Cookie", sessionCookie(await startSession(db, inv.member_id), c.req.raw));
  return c.json({ ok: true });
});

// ---- ログイン確認(上のもの以外のすべての /api に適用) ----
app.use("/api/*", async (c, next) => {
  const user = await loadUser(c.env.DB, c.req.raw);
  if (!user) return c.json({ error: "ログインが必要です", login: true }, 401);
  c.set("user", user);
  await next();
});

const requireRecorder = async (c, next) => {
  if (!c.get("user").isRecorder) return c.json({ error: "記録係のみ操作できます" }, 403);
  await next();
};

// ---- 自分の情報 ----
// app: 画面に出すプロジェクト名・チーム名・記録係の名前(固定の文字にせず、データベースから出す)
app.get("/api/me", async (c) => {
  const u = c.get("user"), db = c.env.DB;
  const [p, rec] = await Promise.all([
    db.prepare("SELECT name, short_name FROM projects ORDER BY id LIMIT 1").first(),
    db.prepare("SELECT name FROM members WHERE is_recorder = 1 AND active = 1 ORDER BY id").all(),
  ]);
  const app = { name: p?.name || "", short: p?.short_name || p?.name || "", recorders: rec.results.map((r) => r.name) };
  return c.json({ loginId: u.loginId, name: u.name, isRecorder: u.isRecorder, isOwner: u.isOwner, memberId: u.memberId, app });
});

// 自分のパスワードを変える
app.post("/api/me/password", async (c) => {
  const db = c.env.DB, u = c.get("user"), b = await c.req.json();
  const ok = await login(db, u.loginId, String(b.current || ""));
  if (ok.error) return c.json({ error: "今のパスワードが違います" }, 400);
  const err = checkCredentials(u.loginId, b.password);
  if (err) return c.json({ error: err }, 400);
  await db.prepare("UPDATE accounts SET pass_hash = ? WHERE member_id = ?").bind(await hashPassword(b.password), u.memberId).run();
  return c.json({ ok: true });
});

// プロジェクト名・チーム名・期間を変える(記録係のみ)
app.patch("/api/projects/:id", async (c) => {
  if (!c.get("user").isRecorder) return c.json({ error: "記録係のみ操作できます" }, 403);
  const b = await c.req.json(), v = (k) => String(b[k] || "").trim();
  const D = /^\d{4}-\d{2}-\d{2}$/;
  if (!v("name")) return c.json({ error: "プロジェクト名を入れてください" }, 400);
  if (!D.test(v("start_date")) || !D.test(v("end_date")) || v("start_date") > v("end_date")) return c.json({ error: "期間を正しく入れてください" }, 400);
  await c.env.DB.prepare("UPDATE projects SET name = ?, short_name = ?, start_date = ?, end_date = ? WHERE id = ?")
    .bind(v("name"), v("short_name") || v("name"), v("start_date"), v("end_date"), Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- プロジェクトの集計(進捗率は 完了タスク ÷ 全タスク で自動計算) ----
async function projectStats(db, projectId) {
  const today = todayJST();
  const s = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(status = 'done') AS done,
              SUM(status != 'done') AS open,
              SUM(status != 'done' AND due_date IS NOT NULL AND due_date < ?) AS overdue
       FROM tasks WHERE project_id = ?`
    )
    .bind(today, projectId)
    .first();
  const latest = await db
    .prepare("SELECT id, title, held_at FROM meetings WHERE project_id = ? AND status = 'published' ORDER BY held_at DESC LIMIT 1")
    .bind(projectId)
    .first();
  const next = await db
    .prepare(
      `SELECT t.id, t.title, t.due_date, t.status, t.priority, m.name AS assignee
       FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id
       WHERE t.project_id = ? AND t.status != 'done'
       ORDER BY CASE t.priority WHEN '高' THEN 0 WHEN '中' THEN 1 WHEN '低' THEN 2 ELSE 3 END, t.due_date IS NULL, t.due_date LIMIT 6`
    )
    .bind(projectId)
    .all();
  const total = s.total || 0;
  return {
    total,
    done: s.done || 0,
    open: s.open || 0,
    overdue: s.overdue || 0,
    progress: total ? Math.round(((s.done || 0) / total) * 100) : 0,
    latestMeeting: latest,
    nextTasks: next.results,
  };
}

app.get("/api/projects", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, start_date, end_date FROM projects ORDER BY id").all();
  const list = await Promise.all(results.map(async (p) => ({ ...p, stats: await projectStats(c.env.DB, p.id) })));
  return c.json(list);
});

app.get("/api/projects/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const project = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!project) return c.json({ error: "見つかりません" }, 404);
  const q = (sql) => db.prepare(sql).bind(id).all().then((r) => r.results);
  const [decisions, qas, issues, milestones, documents, policies, facts, diffs] = await Promise.all([
    q(`SELECT d.*, mt.title AS meeting_title FROM decisions d LEFT JOIN meetings mt ON mt.id = d.meeting_id
       WHERE d.project_id = ? ORDER BY d.decided_on DESC, d.id DESC`),
    q(`SELECT * FROM qas WHERE project_id = ? ORDER BY (answer = '') DESC, id`),
    q(`SELECT * FROM issues WHERE project_id = ? ORDER BY status, CASE priority WHEN '高' THEN 0 WHEN '中' THEN 1 WHEN '低' THEN 2 ELSE 3 END, id`),
    q(`SELECT * FROM milestones WHERE project_id = ? ORDER BY date`),
    q(`SELECT * FROM documents WHERE project_id = ? ORDER BY id`),
    q(`SELECT * FROM policies WHERE project_id = ? ORDER BY sort, id`),
    q(`SELECT f.*, s.title AS source_title, s.year AS source_year FROM facts f LEFT JOIN sources s ON s.id = f.source_id
       WHERE f.project_id = ? ORDER BY f.sort, f.id`),
    q(`SELECT d.*, s.title AS source_title, b.title AS base_title FROM diffs d JOIN sources s ON s.id = d.source_id
       LEFT JOIN sources b ON b.id = d.base_source_id WHERE d.project_id = ? ORDER BY d.id DESC LIMIT 3`),
  ]);
  return c.json({ project, stats: await projectStats(db, id), decisions, qas, issues, milestones, documents, policies, facts, diffs });
});

// ---- メンバー ----
app.get("/api/members", async (c) => {
  // 通常は名簿にいる人だけ。?all=1 で外した人も含める(過去の議事録の表示用)
  const sql = `SELECT m.*, a.login_id IS NOT NULL AS has_account FROM members m LEFT JOIN accounts a ON a.member_id = m.id
    ${c.req.query("all") ? "" : "WHERE m.active = 1"} ORDER BY m.id`;
  const { results } = await c.env.DB.prepare(sql).all();
  return c.json(results);
});

// 自己紹介の項目(全員が編集できる)
const PROFILE_FIELDS = ["name", "display_name", "profile_url", "region", "motivation", "can_help", "want_to_do",
  "involvement", "message", "duty_plan", "duty_fixed", "role"];

app.post("/api/members", requireRecorder, async (c) => {
  const b = await c.req.json();
  const name = String(b.name || "").trim();
  if (!name) return c.json({ error: "呼び名を入れてください" }, 400);
  const dup = await c.env.DB.prepare("SELECT id, active FROM members WHERE name = ?").bind(name).first();
  if (dup?.active) return c.json({ error: `「${name}」はすでに名簿にいます` }, 400);
  const by = c.get("user").name;
  let id;
  if (dup) { // 以前に外した人を名簿に戻す
    await c.env.DB.prepare("UPDATE members SET active = 1 WHERE id = ?").bind(dup.id).run();
    id = dup.id;
  } else {
    const r = await c.env.DB.prepare("INSERT INTO members (name, display_name, role) VALUES (?, ?, '')").bind(name, String(b.display_name || "").trim()).run();
    id = r.meta.last_row_id;
  }
  await logChange(c.env.DB, "members", id, "create", null, { name }, by);
  return c.json(await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first());
});

app.patch("/api/members/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json();
  const before = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "見つかりません" }, 404);
  const set = {};
  for (const f of PROFILE_FIELDS) if (f in b) set[f] = String(b[f] ?? "").trim();
  if ("name" in set && !set.name) return c.json({ error: "呼び名は空にできません" }, 400);
  if ("is_recorder" in b && !!b.is_recorder !== !!before.is_recorder) { // 記録係の付け外しは記録係だけ
    if (!c.get("user").isRecorder) return c.json({ error: "記録係の変更は記録係のみできます" }, 403);
    if (before.is_owner && !b.is_recorder) return c.json({ error: "管理者は記録係から外せません" }, 400);
    set.is_recorder = b.is_recorder ? 1 : 0;
  }
  const keys = Object.keys(set);
  if (!keys.length) return c.json({ error: "変更がありません" }, 400);
  await c.env.DB.prepare(`UPDATE members SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => set[k]), id).run();
  await logChange(c.env.DB, "members", id, "update", Object.fromEntries(keys.map((k) => [k, before[k]])), set, c.get("user").name);
  return c.json(await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first());
});

// 名簿から外す(記録係のみ)。過去の議事録・出欠・タスクの名前は残し、ログインもできなくなる
app.delete("/api/members/:id", requireRecorder, async (c) => {
  const id = Number(c.req.param("id"));
  const m = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  if (!m) return c.json({ error: "見つかりません" }, 404);
  if (id === c.get("user").memberId) return c.json({ error: "自分自身は外せません" }, 400);
  if (m.is_owner) return c.json({ error: "管理者は外せません" }, 400);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET active = 0, is_recorder = 0 WHERE id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM login_sessions WHERE member_id = ?").bind(id), // ログイン中でもすぐ使えなくする
    c.env.DB.prepare("DELETE FROM invites WHERE member_id = ?").bind(id),
  ]);
  await logChange(c.env.DB, "members", id, "delete", m, null, c.get("user").name);
  return c.json({ ok: true });
});

// ---- 招待リンク・パスワード再設定リンクを作る(記録係のみ) ----
app.post("/api/members/:id/invite", requireRecorder, async (c) => {
  const id = Number(c.req.param("id"));
  const m = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first();
  if (!m || !m.active) return c.json({ error: "名簿にいない人です" }, 404);
  const { token, days } = await createInvite(c.env.DB, id, c.get("user").name);
  return c.json({ url: `${new URL(c.req.url).origin}/#/invite/${token}`, days });
});

// ---- 変更履歴(誰がいつ何を直したか) ----
async function logChange(db, table, id, action, before, after, by) {
  await db
    .prepare("INSERT INTO change_log (table_name, record_id, action, before_json, after_json, changed_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(table, id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, by)
    .run();
}

// ---- タスク(全員が追加・修正できる) ----
const TASK_FIELDS = ["title", "assignee_id", "start_date", "due_date", "status", "note", "done_criteria", "priority"];
const STATUSES = ["todo", "doing", "done"];

function cleanTask(input) {
  const t = {};
  for (const f of TASK_FIELDS) if (f in input) t[f] = input[f] === "" ? null : input[f];
  if ("assignee_id" in t && t.assignee_id != null) t.assignee_id = Number(t.assignee_id);
  if ("status" in t && !STATUSES.includes(t.status)) throw new Error("状態の値が正しくありません");
  if (t.priority != null && !["高", "中", "低"].includes(t.priority)) throw new Error("優先度の値が正しくありません");
  if ("title" in t && !String(t.title ?? "").trim()) throw new Error("タスクの内容を入れてください");
  if (t.start_date && t.due_date && t.start_date > t.due_date) throw new Error("開始日が期限より後になっています");
  return t;
}

const TASK_SELECT = `SELECT t.*, m.name AS assignee, mt.title AS meeting_title, mt.held_at AS meeting_held_at, src.title AS source_title
  FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id LEFT JOIN meetings mt ON mt.id = t.meeting_id
  LEFT JOIN sources src ON src.id = t.source_id`;

app.get("/api/projects/:id/tasks", async (c) => {
  const { results } = await c.env.DB.prepare(`${TASK_SELECT} WHERE t.project_id = ?
    ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.id`).bind(Number(c.req.param("id"))).all();
  return c.json(results);
});

app.post("/api/projects/:id/tasks", async (c) => {
  let t;
  try { t = cleanTask(await c.req.json()); } catch (e) { return c.json({ error: e.message }, 400); }
  if (!t.title) return c.json({ error: "タスクの内容を入れてください" }, 400);
  const by = c.get("user").name;
  const r = await c.env.DB.prepare(
    `INSERT INTO tasks (project_id, title, assignee_id, start_date, due_date, status, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(c.req.param("id")), t.title, t.assignee_id ?? null, t.start_date ?? null, t.due_date ?? null, t.status ?? "todo", t.note ?? "", by).run();
  const created = await c.env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?`).bind(r.meta.last_row_id).first();
  await logChange(c.env.DB, "tasks", created.id, "create", null, created, by);
  return c.json(created);
});

app.patch("/api/tasks/:id", async (c) => {
  const id = Number(c.req.param("id"));
  let t;
  try { t = cleanTask(await c.req.json()); } catch (e) { return c.json({ error: e.message }, 400); }
  const before = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "見つかりません" }, 404);
  const merged = { ...before, ...t };
  if (merged.start_date && merged.due_date && merged.start_date > merged.due_date) return c.json({ error: "開始日が期限より後になっています" }, 400);
  const keys = Object.keys(t);
  if (!keys.length) return c.json({ error: "変更がありません" }, 400);
  const by = c.get("user").name;
  await c.env.DB.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
    .bind(...keys.map((k) => t[k]), by, id).run();
  const after = await c.env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?`).bind(id).first();
  await logChange(c.env.DB, "tasks", id, "update", Object.fromEntries(keys.map((k) => [k, before[k]])), t, by);
  return c.json(after);
});

app.delete("/api/tasks/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "見つかりません" }, 404);
  await c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  await logChange(c.env.DB, "tasks", id, "delete", before, null, c.get("user").name); // 履歴に中身を残すので後から戻せる
  return c.json({ ok: true });
});

// ---- 会議・議事録 ----
app.get("/api/projects/:id/meetings", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.title, m.held_at, m.status, m.created_by,
            (SELECT COUNT(*) FROM attendance a WHERE a.meeting_id = m.id AND a.status != 'absent') AS attendees,
            (SELECT COUNT(*) FROM decisions d WHERE d.meeting_id = m.id) AS decisions,
            (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id = m.id) AS tasks
     FROM meetings m WHERE m.project_id = ? AND (m.status = 'published' OR ?) ORDER BY m.held_at DESC`
  ).bind(Number(c.req.param("id")), c.get("user").isRecorder ? 1 : 0).all(); // 下書きは記録係だけに見せる
  return c.json(results);
});

app.get("/api/meetings/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const meeting = await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first();
  if (!meeting) return c.json({ error: "見つかりません" }, 404);
  const q = (sql) => db.prepare(sql).bind(id).all().then((r) => r.results);
  const [attendance, decisions, tasks, issues, qas] = await Promise.all([
    q(`SELECT a.status, a.note, m.name, m.role, m.id AS member_id FROM members m
       LEFT JOIN attendance a ON a.member_id = m.id AND a.meeting_id = ? ORDER BY m.id`),
    q("SELECT * FROM decisions WHERE meeting_id = ? ORDER BY id"),
    q(`SELECT t.*, m.name AS assignee FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id WHERE t.meeting_id = ? ORDER BY t.due_date IS NULL, t.due_date, t.id`),
    q("SELECT * FROM issues WHERE meeting_id = ? ORDER BY id"),
    q("SELECT * FROM qas WHERE meeting_id = ? ORDER BY id"),
  ]);
  return c.json({ meeting, attendance, decisions, tasks, issues, qas });
});

// ---- 議事録の作成(記録係のみ): 下書き保存 → 公開 ----
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// 「## 見出し」「- 箇条書き」「普通の文」だけの簡単な書き方 → 議事録の本文HTML(すべて文字として安全に変換)
function discussionToHtml(text) {
  const out = [];
  let list = false;
  const close = () => { if (list) { out.push("</ul>"); list = false; } };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    if (line.startsWith("## ")) { close(); out.push(`<h3>${esc(line.slice(3))}</h3>`); }
    else if (line.startsWith("- ") || line.startsWith("・")) {
      if (!list) { out.push("<ul>"); list = true; }
      out.push(`<li>${esc(line.replace(/^(- |・)/, ""))}</li>`);
    } else { close(); out.push(`<p>${esc(line)}</p>`); }
  }
  close();
  return out.length ? `<h2>議論の内容</h2>${out.join("")}` : "";
}

const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

app.post("/api/projects/:id/meetings/draft", requireRecorder, async (c) => {
  const projectId = Number(c.req.param("id"));
  const { id, payload } = await c.req.json();
  const title = String(payload?.title || "").trim() || "（会議名未入力）";
  const heldAt = DT.test(payload?.held_at || "") ? payload.held_at : todayJST() + " 20:00";
  const by = c.get("user").name;
  if (id) {
    const m = await c.env.DB.prepare("SELECT status FROM meetings WHERE id = ?").bind(id).first();
    if (!m || m.status !== "draft") return c.json({ error: "公開済みの議事録は下書きとして上書きできません" }, 400);
    await c.env.DB.prepare("UPDATE meetings SET title = ?, held_at = ?, draft_json = ? WHERE id = ?")
      .bind(title, heldAt, JSON.stringify(payload), id).run();
    return c.json({ id });
  }
  const r = await c.env.DB.prepare("INSERT INTO meetings (project_id, title, held_at, status, draft_json, created_by) VALUES (?, ?, ?, 'draft', ?, ?)")
    .bind(projectId, title, heldAt, JSON.stringify(payload), by).run();
  return c.json({ id: r.meta.last_row_id });
});

app.delete("/api/meetings/:id", requireRecorder, async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const m = await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first();
  if (!m) return c.json({ error: "見つかりません" }, 404);
  const deleteTasks = c.req.query("tasks") === "delete";
  // 消す前の中身を変更履歴に丸ごと残す(間違えて消しても後から戻せるように)
  const q = (sql) => db.prepare(sql).bind(id).all().then((r) => r.results);
  const snapshot = {
    meeting: m,
    attendance: await q("SELECT * FROM attendance WHERE meeting_id = ?"),
    decisions: await q("SELECT * FROM decisions WHERE meeting_id = ?"),
    issues: await q("SELECT * FROM issues WHERE meeting_id = ?"),
    qas: await q("SELECT * FROM qas WHERE meeting_id = ?"),
    tasks: await q("SELECT * FROM tasks WHERE meeting_id = ?"),
  };
  await db.batch([
    db.prepare("DELETE FROM attendance WHERE meeting_id = ?").bind(id),
    db.prepare("DELETE FROM decisions WHERE meeting_id = ?").bind(id),
    db.prepare("DELETE FROM issues WHERE meeting_id = ?").bind(id),
    db.prepare("DELETE FROM qas WHERE meeting_id = ?").bind(id),
    deleteTasks
      ? db.prepare("DELETE FROM tasks WHERE meeting_id = ?").bind(id)
      : db.prepare("UPDATE tasks SET meeting_id = NULL WHERE meeting_id = ?").bind(id), // タスクは残し、会議とのつながりだけ外す
    // カレンダーに載せた会議日(同じ日に他の会議がなければ)
    db.prepare(`DELETE FROM milestones WHERE project_id = ? AND kind = 'meeting' AND date = ? AND title = ?
      AND NOT EXISTS (SELECT 1 FROM meetings WHERE project_id = ? AND id != ? AND substr(held_at, 1, 10) = ?)`)
      .bind(m.project_id, m.held_at.slice(0, 10), m.title, m.project_id, id, m.held_at.slice(0, 10)),
    db.prepare("DELETE FROM meetings WHERE id = ?").bind(id),
  ]);
  await logChange(db, "meetings", id, "delete", snapshot, { deleteTasks }, c.get("user").name);
  return c.json({ ok: true });
});

// 公開済みの議事録を修正(記録係のみ)。タスクはタスク画面で直すので、ここでは触らない
app.post("/api/meetings/:id/update", requireRecorder, async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const m = await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first();
  if (!m) return c.json({ error: "見つかりません" }, 404);
  if (m.status !== "published") return c.json({ error: "下書きは作成画面で編集してください" }, 400);
  const p = (await c.req.json()).payload || {};
  if (!String(p.title || "").trim()) return c.json({ error: "会議名を入れてください" }, 400);
  if (!DT.test(p.held_at || "")) return c.json({ error: "日時を正しく入れてください" }, 400);
  const pid = m.project_id, day = p.held_at.slice(0, 10), by = c.get("user").name;
  const text = (v) => (Array.isArray(v) ? v.join("\n") : String(v || "")).trim();
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((x) => String(x).trim()).filter(Boolean);
  const oldIssues = await db.prepare("SELECT content, status FROM issues WHERE meeting_id = ?").bind(id).all().then((r) => r.results);
  const before = { meeting: m, attendance: await db.prepare("SELECT * FROM attendance WHERE meeting_id = ?").bind(id).all().then((r) => r.results) };
  // 議論の内容が空で、以前の本文(図など)がある場合は、本文をそのまま残す
  const disc = text(p.discussion);
  const body = disc ? discussionToHtml(disc) : p.keep_body ? m.body_html : "";

  const stmts = [
    db.prepare(`UPDATE meetings SET title = ?, held_at = ?, ended_at = ?, place = ?, facilitator = ?, agenda = ?, summary = ?,
        confirmations = ?, next_actions = ?, progress_note = ?, next_checks = ?, body_html = ?, discussion = ? WHERE id = ?`)
      .bind(p.title.trim(), p.held_at, p.ended_at ? `${day} ${p.ended_at}` : null, p.place || "", p.facilitator || "",
        text(p.agenda), text(p.summary), text(p.confirmations), text(p.next_actions), text(p.progress_note), text(p.next_checks), body, disc, id),
    db.prepare("DELETE FROM attendance WHERE meeting_id = ?").bind(id),
    db.prepare("DELETE FROM decisions WHERE meeting_id = ?").bind(id),
    db.prepare("DELETE FROM issues WHERE meeting_id = ?").bind(id),
    db.prepare("DELETE FROM qas WHERE meeting_id = ?").bind(id),
  ];
  for (const a of p.attendance || []) {
    if (!a.member_id || !["present", "listen", "absent"].includes(a.status)) continue;
    stmts.push(db.prepare("INSERT INTO attendance (meeting_id, member_id, status, note) VALUES (?, ?, ?, ?)").bind(id, Number(a.member_id), a.status, a.note || ""));
  }
  for (const d of list(p.decisions)) stmts.push(db.prepare("INSERT INTO decisions (project_id, meeting_id, content, decided_on) VALUES (?, ?, ?, ?)").bind(pid, id, d, day));
  for (const s2 of list(p.issues)) {
    const st = oldIssues.find((x) => x.content === s2)?.status || "open"; // 解決済みにした課題は、その状態を引き継ぐ
    stmts.push(db.prepare("INSERT INTO issues (project_id, meeting_id, content, status) VALUES (?, ?, ?, ?)").bind(pid, id, s2, st));
  }
  for (const q of p.qas || []) {
    if (!String(q.question || "").trim()) continue;
    stmts.push(db.prepare("INSERT INTO qas (project_id, meeting_id, category, question, answer, asked_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(pid, id, p.title.trim(), q.question.trim(), (q.answer || "").trim(), (q.asked_by || "").trim()));
  }
  await db.batch(stmts);
  await logChange(db, "meetings", id, "update", before, { title: p.title, held_at: p.held_at }, by);
  return c.json({ ok: true });
});

app.post("/api/meetings/:id/publish", requireRecorder, async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const m = await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first();
  if (!m) return c.json({ error: "見つかりません" }, 404);
  if (m.status !== "draft") return c.json({ error: "すでに公開済みです" }, 400);
  const p = (await c.req.json()).payload || {};
  if (!String(p.title || "").trim()) return c.json({ error: "会議名を入れてください" }, 400);
  if (!DT.test(p.held_at || "")) return c.json({ error: "日時を正しく入れてください" }, 400);
  const by = c.get("user").name;
  const pid = m.project_id;
  const day = p.held_at.slice(0, 10);
  const text = (v) => (Array.isArray(v) ? v.join("\n") : String(v || "")).trim();
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((x) => String(x).trim()).filter(Boolean);

  const stmts = [
    db.prepare(`UPDATE meetings SET title = ?, held_at = ?, ended_at = ?, place = ?, facilitator = ?, agenda = ?, summary = ?,
        confirmations = ?, next_actions = ?, progress_note = ?, next_checks = ?, body_html = ?, status = 'published',
        draft_json = NULL, published_at = datetime('now') WHERE id = ?`)
      .bind(p.title.trim(), p.held_at, p.ended_at ? `${day} ${p.ended_at}` : null, p.place || "", p.facilitator || "",
        text(p.agenda), text(p.summary), text(p.confirmations), text(p.next_actions), text(p.progress_note), text(p.next_checks),
        discussionToHtml(p.discussion), id),
    db.prepare("UPDATE meetings SET discussion = ? WHERE id = ?").bind(text(p.discussion), id),
  ];
  for (const a of p.attendance || []) {
    if (!a.member_id || !["present", "listen", "absent"].includes(a.status)) continue;
    stmts.push(db.prepare("INSERT OR REPLACE INTO attendance (meeting_id, member_id, status, note) VALUES (?, ?, ?, ?)").bind(id, Number(a.member_id), a.status, a.note || ""));
  }
  for (const d of list(p.decisions)) stmts.push(db.prepare("INSERT INTO decisions (project_id, meeting_id, content, decided_on) VALUES (?, ?, ?, ?)").bind(pid, id, d, day));
  for (const t of p.tasks || []) {
    if (!t.register || !String(t.title || "").trim()) continue;
    const start = t.start_date || null, due = t.due_date || null;
    if (start && due && start > due) return c.json({ error: `「${t.title}」の開始日が期限より後になっています` }, 400);
    stmts.push(db.prepare("INSERT INTO tasks (project_id, title, assignee_id, start_date, due_date, status, meeting_id, updated_by) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)")
      .bind(pid, t.title.trim(), t.assignee_id ? Number(t.assignee_id) : null, start, due, id, by));
  }
  for (const s of list(p.issues)) stmts.push(db.prepare("INSERT INTO issues (project_id, meeting_id, content) VALUES (?, ?, ?)").bind(pid, id, s));
  for (const q of p.qas || []) {
    if (!String(q.question || "").trim()) continue;
    stmts.push(db.prepare("INSERT INTO qas (project_id, meeting_id, category, question, answer, asked_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(pid, id, p.title.trim(), q.question.trim(), (q.answer || "").trim(), (q.asked_by || "").trim()));
  }
  // カレンダーに会議日を載せる(同じ日・同じ名前がなければ)
  stmts.push(db.prepare(`INSERT INTO milestones (project_id, date, title, kind) SELECT ?, ?, ?, 'meeting'
      WHERE NOT EXISTS (SELECT 1 FROM milestones WHERE project_id = ? AND date = ? AND kind = 'meeting')`).bind(pid, day, p.title.trim(), pid, day));
  if (p.next_meeting && /^\d{4}-\d{2}-\d{2}$/.test(p.next_meeting.date || "")) {
    const nt = `次回会議${p.next_meeting.time ? `（${p.next_meeting.time}〜）` : ""}`;
    stmts.push(db.prepare(`INSERT INTO milestones (project_id, date, title, kind) SELECT ?, ?, ?, 'meeting'
        WHERE NOT EXISTS (SELECT 1 FROM milestones WHERE project_id = ? AND date = ? AND kind = 'meeting')`).bind(pid, p.next_meeting.date, nt, pid, p.next_meeting.date));
  }
  await db.batch(stmts); // まとめて1回で書き込む(途中で失敗したら全部取り消し)
  await logChange(db, "meetings", id, "update", { status: "draft" }, { status: "published", title: p.title }, by);
  return c.json({ ok: true, id });
});

// ---- 文字起こし(記録係のみ。録音画面から約20秒ごとに音声が届く。音声は保存しない) ----
const HALLUCINATIONS = ["ご視聴ありがとうございました", "チャンネル登録", "ご清聴ありがとうございました", "おやすみなさい"];

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

app.post("/api/transcribe", requireRecorder, async (c) => {
  if (!c.env.AI) return c.json({ error: "この環境では文字起こしを使えません（本番のサイトで使ってください）" }, 501);
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.length < 1000) return c.json({ segments: [] });
  if (audio.length > 5_000_000) return c.json({ error: "音声が大きすぎます" }, 400);
  const { results: members } = await c.env.DB.prepare("SELECT name FROM members").all();
  let r;
  try {
    r = await c.env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: toBase64(audio),
      language: "ja",
      vad_filter: true,
      condition_on_previous_text: false,
      // 名前や用語のヒント(聞き取りの精度が上がる)
      initial_prompt: `会議の会話です。参加者：${members.map((m) => m.name).join("、")}。`,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/limit|quota|neuron|429/i.test(msg)) return c.json({ error: "本日の無料の文字起こし枠を使い切りました。録音は続きますが、文字起こしは明日以降になります。" }, 429);
    return c.json({ error: "文字起こしに失敗しました：" + msg }, 502);
  }
  const segs = (r.segments?.length ? r.segments : [{ start: 0, text: r.text || "" }])
    .map((s) => ({ start: Number(s.start) || 0, text: String(s.text || "").trim() }))
    .filter((s) => s.text && !HALLUCINATIONS.some((h) => s.text.includes(h)) && !/^[\d\s、。,.!?a-zA-Z]{0,8}$/.test(s.text));
  return c.json({ segments: segs });
});

// ---- 情報源(要項・資料・企画書など) ----
// ファイルは KV(SOURCE_FILES) に保存。無料枠は合計1GB・1ファイル25MBまで
const STORAGE_LIMIT = 1_000_000_000;
const FILE_LIMIT = 25 * 1024 * 1024;
const VERSIONED = ["要項・ルール", "案内・配布資料"]; // 新しい版が出たら差し替えるもの
const SOURCE_STATUS = ["latest", "reference", "old"];

const canEditSource = (user, src) => user.isRecorder || src.uploaded_by === user.name;

async function storageUsed(db) {
  const r = await db.prepare("SELECT COALESCE(SUM(file_size), 0) AS used FROM sources").first();
  return r.used;
}

// 同じ分類で「最新」にしたら、それまでの最新は「古い版」にする
async function demoteOthers(db, src) {
  if (src.status !== "latest" || !VERSIONED.includes(src.category)) return;
  await db.prepare("UPDATE sources SET status = 'old' WHERE project_id = ? AND category = ? AND status = 'latest' AND id != ?")
    .bind(src.project_id, src.category, src.id).run();
}

app.get("/api/projects/:id/sources", async (c) => {
  const db = c.env.DB, pid = Number(c.req.param("id"));
  const { results } = await db.prepare(
    `SELECT s.id, s.title, s.category, s.year, s.status, s.file_name, s.file_size, s.mime, s.origin, s.note, s.uploaded_by, s.created_at,
       length(s.text) AS text_length,
       (SELECT COUNT(*) FROM facts f WHERE f.source_id = s.id) AS facts,
       (SELECT COUNT(*) FROM tasks t WHERE t.source_id = s.id) AS tasks
     FROM sources s WHERE s.project_id = ?
     ORDER BY CASE s.status WHEN 'latest' THEN 0 WHEN 'reference' THEN 1 ELSE 2 END, s.category, s.id DESC`
  ).bind(pid).all();
  return c.json({ sources: results, used: await storageUsed(db), limit: STORAGE_LIMIT });
});

app.get("/api/sources/:id", async (c) => {
  const db = c.env.DB, id = Number(c.req.param("id"));
  const source = await db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first();
  if (!source) return c.json({ error: "見つかりません" }, 404);
  const q = (sql) => db.prepare(sql).bind(id).all().then((r) => r.results);
  const [facts, diffs, tasks] = await Promise.all([
    q("SELECT * FROM facts WHERE source_id = ? ORDER BY sort, id"),
    q(`SELECT d.*, b.title AS base_title FROM diffs d LEFT JOIN sources b ON b.id = d.base_source_id WHERE d.source_id = ? ORDER BY d.id DESC`),
    q("SELECT id, title, status FROM tasks WHERE source_id = ? ORDER BY id"),
  ]);
  return c.json({ source, facts, diffs, tasks });
});

// ファイルを開く(PDFはブラウザでそのまま表示)
app.get("/api/sources/:id/file", async (c) => {
  const src = await c.env.DB.prepare("SELECT file_key, file_name, mime FROM sources WHERE id = ?").bind(Number(c.req.param("id"))).first();
  if (!src?.file_key) return c.json({ error: "ファイルがありません" }, 404);
  const body = await c.env.SOURCE_FILES.get(src.file_key, "arrayBuffer");
  if (!body) return c.json({ error: "ファイルが見つかりません" }, 404);
  return new Response(body, { headers: {
    "Content-Type": src.mime || "application/octet-stream",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(src.file_name)}`,
    "Cache-Control": "private, max-age=3600",
  } });
});

// 登録(参加者なら誰でも)。ファイルは任意。PDFの本文は画面側で抜き出して text で送る
app.post("/api/projects/:id/sources", async (c) => {
  const db = c.env.DB, pid = Number(c.req.param("id")), user = c.get("user");
  const form = await c.req.formData();
  const v = (k) => String(form.get(k) || "").trim();
  const title = v("title");
  if (!title) return c.json({ error: "タイトルを入れてください" }, 400);
  if (!v("category")) return c.json({ error: "分類を選んでください" }, 400);
  const status = SOURCE_STATUS.includes(v("status")) ? v("status") : "latest";
  const file = form.get("file");
  let size = 0;
  if (file && typeof file !== "string" && file.size) {
    size = file.size;
    if (size > FILE_LIMIT) return c.json({ error: `ファイルが大きすぎます（${(size / 1048576).toFixed(1)}MB）。25MBまでです` }, 400);
    const used = await storageUsed(db);
    if (used + size > STORAGE_LIMIT) return c.json({ error: `保管容量が足りません（使用中 ${(used / 1e6).toFixed(0)}MB／${STORAGE_LIMIT / 1e6}MB）。不要な情報源を削除してください` }, 400);
  }
  const r = await db.prepare(
    `INSERT INTO sources (project_id, title, category, year, status, origin, text, note, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(pid, title, v("category"), v("year"), status, v("origin"), v("text"), v("note"), user.name).run();
  const id = r.meta.last_row_id;
  if (size) {
    // 保管用のキーは英数字だけにする(日本語のファイル名は表示用に別で持つ)
    const ext = (file.name.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0].toLowerCase();
    const key = `src/${id}/file${ext}`;
    await c.env.SOURCE_FILES.put(key, await file.arrayBuffer());
    await db.prepare("UPDATE sources SET file_key = ?, file_name = ?, file_size = ?, mime = ? WHERE id = ?")
      .bind(key, file.name, size, file.type || "application/octet-stream", id).run();
  }
  const src = await db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first();
  await demoteOthers(db, src);
  await logChange(db, "sources", id, "create", null, { title, category: src.category }, user.name);
  return c.json({ id });
});

app.patch("/api/sources/:id", async (c) => {
  const db = c.env.DB, id = Number(c.req.param("id")), user = c.get("user");
  const before = await db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "見つかりません" }, 404);
  if (!canEditSource(user, before)) return c.json({ error: "登録した人か記録係だけが直せます" }, 403);
  const b = await c.req.json();
  const set = {};
  for (const k of ["title", "category", "year", "status", "origin", "note", "text"]) if (k in b) set[k] = String(b[k] ?? "").trim();
  if ("status" in set && !SOURCE_STATUS.includes(set.status)) return c.json({ error: "状態の値が正しくありません" }, 400);
  if ("title" in set && !set.title) return c.json({ error: "タイトルを入れてください" }, 400);
  const keys = Object.keys(set);
  if (!keys.length) return c.json({ error: "変更がありません" }, 400);
  await db.prepare(`UPDATE sources SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => set[k]), id).run();
  await demoteOthers(db, { ...before, ...set });
  await logChange(db, "sources", id, "update", Object.fromEntries(keys.filter((k) => k !== "text").map((k) => [k, before[k]])), { ...set, text: set.text ? "(本文を更新)" : undefined }, user.name);
  return c.json({ ok: true });
});

app.delete("/api/sources/:id", async (c) => {
  const db = c.env.DB, id = Number(c.req.param("id")), user = c.get("user");
  const src = await db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first();
  if (!src) return c.json({ error: "見つかりません" }, 404);
  if (!canEditSource(user, src)) return c.json({ error: "登録した人か記録係だけが削除できます" }, 403);
  if (src.file_key) await c.env.SOURCE_FILES.delete(src.file_key);
  await db.batch([
    db.prepare("DELETE FROM diffs WHERE source_id = ? OR base_source_id = ?").bind(id, id),
    db.prepare("UPDATE facts SET source_id = NULL WHERE source_id = ?").bind(id), // 整理した公式事項・タスク・Q&Aは残す
    db.prepare("UPDATE tasks SET source_id = NULL WHERE source_id = ?").bind(id),
    db.prepare("UPDATE qas SET source_id = NULL WHERE source_id = ?").bind(id),
    db.prepare("DELETE FROM sources WHERE id = ?").bind(id),
  ]);
  const { text, ...rest } = src;
  await logChange(db, "sources", id, "delete", rest, null, user.name);
  return c.json({ ok: true });
});

// AIの整理結果を登録(タスク・公式事項・Q&A・カレンダーの節目)。記録係のみ
app.post("/api/sources/:id/organize", requireRecorder, async (c) => {
  const db = c.env.DB, id = Number(c.req.param("id")), by = c.get("user").name;
  const src = await db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first();
  if (!src) return c.json({ error: "見つかりません" }, 404);
  const p = await c.req.json();
  const D = /^\d{4}-\d{2}-\d{2}$/;
  const stmts = [];
  const maxSort = (await db.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM facts").first()).m;
  (p.facts || []).filter((f) => f.register && String(f.title || "").trim()).forEach((f, i) =>
    stmts.push(db.prepare("INSERT INTO facts (project_id, source_id, title, content, page, kind, sort) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(src.project_id, id, f.title.trim(), String(f.content || "").trim(), String(f.page || ""), ["date", "money", "rule"].includes(f.kind) ? f.kind : "rule", maxSort + 1 + i)));
  for (const t of (p.tasks || []).filter((t) => t.register && String(t.title || "").trim())) {
    const start = D.test(t.start_date || "") ? t.start_date : null, due = D.test(t.due_date || "") ? t.due_date : null;
    if (start && due && start > due) return c.json({ error: `「${t.title}」の開始日が期限より後になっています` }, 400);
    stmts.push(db.prepare(`INSERT INTO tasks (project_id, title, assignee_id, start_date, due_date, status, note, done_criteria, source_id, updated_by)
      VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`).bind(src.project_id, t.title.trim(), t.assignee_id ? Number(t.assignee_id) : null, start, due,
      String(t.page ? `出典 ${t.page}` : ""), String(t.done_criteria || ""), id, by));
  }
  for (const q of (p.qas || []).filter((q) => q.register && String(q.question || "").trim()))
    stmts.push(db.prepare("INSERT INTO qas (project_id, category, question, answer, asked_by, source_id) VALUES (?, ?, ?, ?, '', ?)")
      .bind(src.project_id, src.title, q.question.trim(), String(q.answer || "").trim(), id));
  for (const m of (p.milestones || []).filter((m) => m.register && D.test(m.date || "") && String(m.title || "").trim()))
    stmts.push(db.prepare("INSERT INTO milestones (project_id, date, end_date, title, kind) VALUES (?, ?, ?, ?, ?)")
      .bind(src.project_id, m.date, D.test(m.end_date || "") ? m.end_date : null, m.title.trim(), ["deadline", "event"].includes(m.kind) ? m.kind : "deadline"));
  if (!stmts.length) return c.json({ error: "登録するものが選ばれていません" }, 400);
  await db.batch(stmts);
  await logChange(db, "sources", id, "update", null, { organized: stmts.length }, by);
  return c.json({ ok: true, count: stmts.length });
});

// 版の差分チェックの結果を保存(記録係のみ)
app.post("/api/sources/:id/diffs", requireRecorder, async (c) => {
  const db = c.env.DB, id = Number(c.req.param("id"));
  const src = await db.prepare("SELECT project_id FROM sources WHERE id = ?").bind(id).first();
  if (!src) return c.json({ error: "見つかりません" }, 404);
  const p = await c.req.json();
  const changes = (p.changes || []).filter((x) => String(x.item || "").trim());
  await db.prepare("INSERT INTO diffs (project_id, source_id, base_source_id, summary, changes, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(src.project_id, id, p.base_source_id ? Number(p.base_source_id) : null, String(p.summary || ""), JSON.stringify(changes), c.get("user").name).run();
  return c.json({ ok: true });
});

app.delete("/api/diffs/:id", requireRecorder, async (c) => {
  await c.env.DB.prepare("DELETE FROM diffs WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// 公式事項の修正・削除(全員)
app.patch("/api/facts/:id", async (c) => {
  const b = await c.req.json();
  const set = {};
  for (const k of ["title", "content", "page", "kind"]) if (k in b) set[k] = String(b[k] ?? "").trim();
  const keys = Object.keys(set);
  if (!keys.length) return c.json({ error: "変更がありません" }, 400);
  await c.env.DB.prepare(`UPDATE facts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => set[k]), Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});
app.delete("/api/facts/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const f = await c.env.DB.prepare("SELECT * FROM facts WHERE id = ?").bind(id).first();
  await c.env.DB.prepare("DELETE FROM facts WHERE id = ?").bind(id).run();
  await logChange(c.env.DB, "facts", id, "delete", f, null, c.get("user").name);
  return c.json({ ok: true });
});

// 課題の状態(未解決／解決済み)の切り替え(全員)
app.patch("/api/issues/:id", async (c) => {
  const b = await c.req.json();
  if (!["open", "resolved"].includes(b.status)) return c.json({ error: "状態の値が正しくありません" }, 400);
  await c.env.DB.prepare("UPDATE issues SET status = ? WHERE id = ?").bind(b.status, Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- 目的と方向性(まとめページ。全員が直せる) ----
app.post("/api/projects/:id/direction", async (c) => {
  const db = c.env.DB, pid = Number(c.req.param("id")), b = await c.req.json(), by = c.get("user").name;
  const before = await db.prepare("SELECT overview, concept FROM projects WHERE id = ?").bind(pid).first();
  const stmts = [db.prepare("UPDATE projects SET overview = ?, concept = ? WHERE id = ?").bind(String(b.overview || ""), String(b.concept || ""), pid)];
  (b.policies || []).forEach((x, i) => {
    const item = String(x.item || "").trim(), content = String(x.content || "").trim();
    if (x.id === "new") { if (item && content) stmts.push(db.prepare("INSERT INTO policies (project_id, item, content, sort) VALUES (?, ?, ?, ?)").bind(pid, item, content, i)); }
    else if (item && content) stmts.push(db.prepare("UPDATE policies SET item = ?, content = ?, sort = ? WHERE id = ? AND project_id = ?").bind(item, content, i, Number(x.id), pid));
  });
  await db.batch(stmts);
  await logChange(db, "projects", pid, "update", before, { overview: b.overview, concept: b.concept, policies: (b.policies || []).length }, by);
  return c.json({ ok: true });
});
app.delete("/api/policies/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM policies WHERE id = ?").bind(id).first();
  await c.env.DB.prepare("DELETE FROM policies WHERE id = ?").bind(id).run();
  await logChange(c.env.DB, "policies", id, "delete", before, null, c.get("user").name);
  return c.json({ ok: true });
});

// ---- 最近の変更 ----
app.get("/api/projects/:id/history", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT l.*, t.title AS task_title FROM change_log l LEFT JOIN tasks t ON l.table_name = 'tasks' AND t.id = l.record_id
     WHERE l.table_name != 'tasks' OR t.project_id = ? OR l.action = 'delete'
     ORDER BY l.id DESC LIMIT 30`
  ).bind(Number(c.req.param("id"))).all();
  return c.json(results);
});

app.all("/api/*", (c) => c.json({ error: "見つかりません" }, 404));

export default app;
