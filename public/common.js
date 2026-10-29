// 画面どうしで共通に使う部品
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
// 画面に出すプロジェクト名・チーム名・記録係(ログイン時に /api/me から入れる)
export const APP = { name: "", short: "", recorders: [] };
export const recordersText = () => APP.recorders.join("・");

export const STATUS_ATT = { present: "出席", listen: "出席（聞き専）", absent: "欠席" };

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status, body });
  return body;
}
