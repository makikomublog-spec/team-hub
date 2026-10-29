// ログインの仕組み(招待リンク＋パスワード)。外部のログインサービスを使わず、このツールだけで完結する。
// ・パスワードはそのまま保存せず、PBKDF2(10万回)で復元できない形にして持つ
// ・ログイン中の印(クッキー)はランダムな文字列。データベースにはそのハッシュだけを置く
// ・招待リンクも同じくハッシュだけを置く(7日間・1回だけ有効)

const enc = new TextEncoder();
const ITER = 100_000;
export const COOKIE = "th_session";
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const LOCK_FAILS = 10;
const LOCK_MIN = 15;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = async (s) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19); // datetime('now') と同じ形

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, ITER))}`;
}

async function verifyPassword(password, stored) {
  const [, iter, salt, hash] = String(stored).split("$");
  const got = await pbkdf2(password, fromB64url(salt), Number(iter));
  const want = fromB64url(hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// ログインIDとパスワードの決まり(画面にも同じ説明を出す)
export function checkCredentials(loginId, password) {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(loginId)) return "ログインIDは半角英数字（と _ . -）で3〜32文字にしてください";
  if (String(password).length < 8) return "パスワードは8文字以上にしてください";
  if (String(password).length > 200) return "パスワードが長すぎます";
  return null;
}

// ---- ログイン中の印(クッキー) ----
function cookieValue(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

export function sessionCookie(token, req) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function startSession(db, memberId) {
  const token = randomToken();
  await db.batch([
    db.prepare("DELETE FROM login_sessions WHERE expires_at < datetime('now')"), // 期限切れの掃除
    db.prepare("INSERT INTO login_sessions (token_hash, member_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256(token), memberId, sqlTime(Date.now() + SESSION_DAYS * 86400_000)),
  ]);
  return token;
}

export async function endSession(db, req) {
  const token = cookieValue(req, COOKIE);
  if (token) await db.prepare("DELETE FROM login_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

// クッキー → 利用者情報。ログインしていなければ null
export async function loadUser(db, req) {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const row = await db.prepare(`SELECT m.*, a.login_id FROM login_sessions s JOIN members m ON m.id = s.member_id
    LEFT JOIN accounts a ON a.member_id = m.id WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).bind(await sha256(token)).first();
  if (!row || !row.active) return null; // 名簿から外された人は使えない
  return { loginId: row.login_id, memberId: row.id, member: row, name: row.name, isRecorder: !!row.is_recorder, isOwner: !!row.is_owner };
}

// ログインIDとパスワードの確認。続けて10回間違えたら15分ロックする
export async function login(db, loginId, password) {
  const a = await db.prepare(`SELECT a.*, m.active FROM accounts a JOIN members m ON m.id = a.member_id WHERE a.login_id = ?`).bind(loginId).first();
  if (!a || !a.active) return { error: "ログインIDかパスワードが違います" };
  if (a.fail_count >= LOCK_FAILS && a.fail_at > sqlTime(Date.now() - LOCK_MIN * 60_000))
    return { error: `パスワードを続けて間違えたため、${LOCK_MIN}分間ログインできません。しばらく待ってからもう一度お試しください` };
  if (!(await verifyPassword(password, a.pass_hash))) {
    const n = a.fail_at && a.fail_at > sqlTime(Date.now() - LOCK_MIN * 60_000) ? a.fail_count + 1 : 1;
    await db.prepare("UPDATE accounts SET fail_count = ?, fail_at = datetime('now') WHERE member_id = ?").bind(n, a.member_id).run();
    return { error: "ログインIDかパスワードが違います" };
  }
  await db.prepare("UPDATE accounts SET fail_count = 0, fail_at = NULL WHERE member_id = ?").bind(a.member_id).run();
  return { memberId: a.member_id };
}

// ---- 招待リンク(パスワード再設定にも使う) ----
export async function createInvite(db, memberId, by) {
  const token = randomToken();
  await db.batch([
    db.prepare("DELETE FROM invites WHERE member_id = ? AND used_at IS NULL").bind(memberId), // 前のリンクは使えなくする
    db.prepare("INSERT INTO invites (token_hash, member_id, created_by, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), memberId, by, sqlTime(Date.now() + INVITE_DAYS * 86400_000)),
  ]);
  return { token, days: INVITE_DAYS };
}

export async function findInvite(db, token) {
  return db.prepare(`SELECT i.*, m.name, m.active, a.login_id FROM invites i JOIN members m ON m.id = i.member_id
    LEFT JOIN accounts a ON a.member_id = i.member_id
    WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > datetime('now')`).bind(await sha256(token)).first();
}
