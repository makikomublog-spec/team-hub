// 手元の確認用に、Cloudflareのふりをする小さなサーバー。受け取った依頼を記録して、SQLは本物のSQLiteで実行する
// 使い方: node setup/test/mock-cf.mjs [--port 8799] [--new-account] [--fail-once=<step>] [--need-email]
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}`));
const PORT = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8799;
const LOG = process.env.MOCK_LOG || "/dev/null";
const GOOD = "good-token-0123456789-abcdefgh";
const ACCOUNTS = arg("two-accounts") ? [{ id: "acct-11111111", name: "第一" }, { id: "acct-22222222", name: "第二" }] : [{ id: "acct-11111111", name: "テスト" }];

const db = new DatabaseSync(":memory:");
const state = { subdomain: arg("new-account") ? null : "tester", d1: [], kv: [], script: null, enabled: false, uploaded: new Set(), log: [] };
let failOnce = arg("fail-once")?.split("=")[1];
let needEmail = !!arg("need-email");

const ok = (result) => ({ success: true, errors: [], messages: [], result });
const bad = (code, message, status = 400) => ({ status, body: { success: false, errors: [{ code, message }], messages: [], result: null } });

async function parts(req, raw) {
  const form = await new Response(raw, { headers: { "Content-Type": req.headers["content-type"] } }).formData();
  const out = {};
  for (const [k, v] of form) out[k] = typeof v === "string" ? { text: v } : { text: await v.text(), type: v.type, name: v.name };
  return out;
}

async function route(req, raw) {
  const u = new URL(req.url, "http://x"), p = u.pathname.replace("/client/v4", ""), m = req.method;
  const body = () => JSON.parse(raw.toString() || "{}");
  const auth = req.headers.authorization || "";
  state.log.push({ m, p });

  // 確認の場面を切り替える（subdomain / others / taken / refuseChange）
  if (p === "/__mock") { Object.assign(state, body()); return { body: { ok: true } }; }
  if (p === "/api/auth/state") return { body: { ok: true } };
  if (p.endsWith("/workers/assets/upload")) {
    if (auth !== "Bearer upload-jwt") return bad(10000, "bad upload jwt", 401);
    const f = await parts(req, raw);
    for (const k of Object.keys(f)) state.uploaded.add(k);
    state.lastUpload = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.type]));
    return { status: 201, body: ok({ jwt: "completion-jwt" }) };
  }
  if (auth !== `Bearer ${GOOD}`) return bad(10000, "Authentication error", 401);
  if (failOnce && p.includes(failOnce)) { failOnce = null; return bad(7000, "pretend failure", 500); }
  if (p === "/user/tokens/verify") return { body: ok({ status: "active" }) };
  if (p === "/accounts") return { body: ok(ACCOUNTS) };

  const a = p.match(/^\/accounts\/([^/]+)(\/.*)$/);
  if (!a) return bad(7003, "not found", 404);
  const r = a[2];
  if (r === "/workers/subdomain" && m === "GET") return state.subdomain ? { body: ok({ subdomain: state.subdomain }) } : bad(10007, "no subdomain", 404);
  if (r === "/workers/subdomain" && m === "PUT") {
    if (state.taken === body().subdomain) return bad(10031, "subdomain already taken", 409);
    if (state.refuseChange && state.subdomain) return bad(10032, "pretend refusal", 400);
    state.subdomain = body().subdomain;
    return { body: ok({ subdomain: state.subdomain }) };
  }
  if (r === "/workers/scripts" && m === "GET") return { body: ok([...(state.others || []), ...(state.script ? ["team-hub"] : [])].map((id) => ({ id }))) };
  if (needEmail && r.startsWith("/d1")) { needEmail = false; return bad(10034, "workers.api.error.email_verification_required", 403); }
  if (r === "/d1/database" && m === "GET") return { body: ok(state.d1.filter((d) => d.name === u.searchParams.get("name"))) };
  if (r === "/d1/database" && m === "POST") { const d = { uuid: "db-aaaaaaaa", name: body().name }; state.d1.push(d); return { body: ok(d) }; }
  if (/^\/d1\/database\/[^/]+\/query$/.test(r)) {
    const { sql, params } = body();
    if (params?.length) { const st = db.prepare(sql); st.run(...params); return { body: ok([{ results: [], success: true }]) }; }
    if (/^\s*select/i.test(sql)) return { body: ok([{ results: db.prepare(sql).all(), success: true }]) };
    db.exec(sql);
    return { body: ok([{ results: [], success: true }]) };
  }
  if (r === "/storage/kv/namespaces" && m === "GET") return { body: ok(state.kv) };
  if (r === "/storage/kv/namespaces" && m === "POST") { const n = { id: "kv-bbbbbbbb", title: body().title }; state.kv.push(n); return { body: ok(n) }; }
  if (r.endsWith("/assets-upload-session")) {
    const { manifest } = body();
    state.manifest = manifest;
    const missing = Object.values(manifest).map((v) => v.hash).filter((h) => !state.uploaded.has(h));
    // 本物と同じく、全部あれば buckets は空で jwt がそのまま完了の印になる
    return missing.length ? { body: ok({ jwt: "upload-jwt", buckets: [missing.slice(0, 4), missing.slice(4)].filter((b) => b.length) }) } : { body: ok({ jwt: "completion-jwt", buckets: [] }) };
  }
  if (/^\/workers\/scripts\/[^/]+$/.test(r) && m === "PUT") {
    const f = await parts(req, raw);
    state.metadata = JSON.parse(f.metadata.text);
    state.modules = Object.fromEntries(Object.entries(f).filter(([k]) => k !== "metadata").map(([k, v]) => [k, { type: v.type, size: v.text.length }]));
    state.script = true;
    return { body: ok({ id: "team-hub" }) };
  }
  if (r.endsWith("/subdomain") && m === "POST") { state.enabled = body(); return { body: ok(state.enabled) }; }
  if (r.endsWith("/subdomain") && m === "GET") return { body: ok(state.enabled || { enabled: false }) };
  if (r.startsWith("/workers/services/")) return bad(10090, "service not found", 404); // wrangler の「初めてのサイトか」の確認
  if (r.endsWith("/secrets")) return { body: ok([]) };
  if (r.endsWith("/deployments")) return { body: ok({ deployments: [] }) };
  return { body: ok({}) }; // wrangler が途中で見に来るだけの依頼
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let out;
  try { out = await route(req, Buffer.concat(chunks)); }
  catch (e) { console.error(e); out = bad(7000, String(e.message), 500); }
  res.writeHead(out.status || 200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(out.body));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((t) => t.name);
  writeFileSync(LOG, JSON.stringify({ ...state, uploaded: [...state.uploaded], tables }, null, 1));
}).listen(PORT, () => console.log("mock cloudflare on", PORT));
