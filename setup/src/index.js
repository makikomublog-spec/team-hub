// 設置ページの中継役。使う人の鍵で、その人のCloudflareアカウントにツールを作る。
// ブラウザからCloudflareへ直接は頼めないので、決まった手順だけをここで代わりに行う。
// 鍵は1回の依頼の間だけメモリにあり、保存も記録もしない。
import BUNDLE from "./app-bundle.js";

const WORKER = "team-hub", DB_NAME = "team-hub-db", KV_TITLE = "team-hub-files";
const ID = /^[A-Za-z0-9-]{8,64}$/;
const SUB = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SITE_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/; // Cloudflareの上限は32文字

class CfError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Cloudflareの返事を、PCが苦手な人にも分かる言葉にする
function friendly(e) {
  const m = String(e.message || "");
  if (e.code === "name")
    return { kind: "name", message: "この名前は使えませんでした。ほかの人が使っている名前かもしれません。別の名前にしてください。" };
  if (m.includes("email_verification_required") || /verify your email/i.test(m))
    return { kind: "email", message: "Cloudflareのメールアドレス確認が済んでいません。Cloudflareから届いたメールを開き、確認のボタンを押してから、もう一度「作る」を押してください。" };
  if (e.code === 1000 || e.code === 6003 || e.code === 9106 || e.code === 9109 || e.code === 10000 || e.code === 10001 || /authenticat|unauthorized/i.test(m))
    return { kind: "key", message: "鍵がうまく使えませんでした。「鍵を作る画面を開く」から鍵を作り直して、貼り付け直してください。" };
  return { kind: "other", message: "途中でうまくいきませんでした。もう一度押すと、続きから進みます。何度やっても同じときは、この画面を教えてくれた人に見せてください。" };
}

async function cf(env, token, path, init = {}) {
  const res = await fetch((env.CF_API || "https://api.cloudflare.com/client/v4") + path, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!data?.success) {
    const err = data?.errors?.[0];
    throw new CfError(err?.code ?? res.status, err?.message ?? `HTTP ${res.status}`);
  }
  return data.result;
}
const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function currentSubdomain(env, t, accountId) {
  try {
    return (await cf(env, t, `/accounts/${accountId}/workers/subdomain`)).subdomain;
  } catch (e) {
    if (e.code === 10007) return null; // まだ住所がない
    throw e;
  }
}
const putSubdomain = (env, t, accountId, subdomain) =>
  cf(env, t, `/accounts/${accountId}/workers/subdomain`, { ...json({ subdomain }), method: "PUT" });

const STEPS = {
  // 鍵が使えるか確かめて、アカウントを調べる
  async check(env, t) {
    await cf(env, t, "/user/tokens/verify");
    const accounts = await cf(env, t, "/accounts?per_page=50");
    if (!accounts?.length) throw new CfError(10000, "no accounts");
    return { accounts: accounts.map((a) => ({ id: a.id, name: a.name })) };
  },

  // 住所の名前を選べるか調べる。名前はアカウントで共通なので、ほかのサイトがあるときは選ばせない
  async place(env, t, { accountId }) {
    const scripts = await cf(env, t, `/accounts/${accountId}/workers/scripts`);
    return { canName: !scripts?.length };
  },

  // サイトの住所（workers.dev）。名前の指定があればそれにする。なければ今の住所を使い、住所がなければ自動で作る
  async address(env, t, { accountId, siteName }) {
    const current = await currentSubdomain(env, t, accountId);
    if (siteName && siteName !== current) {
      try {
        return { subdomain: (await putSubdomain(env, t, accountId, siteName)).subdomain };
      } catch (e) {
        if (friendly(e).kind !== "other") throw e;
        // 取られている名前は選び直してもらう。今の住所を変えられないだけなら、そのまま作って完成の画面で案内する
        if (!current || e.code === 10031 || /taken|already|unavailable/i.test(e.message)) throw new CfError("name", e.message);
        return { subdomain: current, nameKept: true };
      }
    }
    if (current) return { subdomain: current };
    for (let i = 0; i < 5; i++) {
      const name = "team-" + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      try {
        const r = await putSubdomain(env, t, accountId, name);
        return { subdomain: r.subdomain };
      } catch (e) {
        if (e.code !== 10031) throw e; // 10031 = その名前はもう使われている
      }
    }
    throw new CfError(10031, "subdomain unavailable");
  },

  // データの置き場
  async database(env, t, { accountId }) {
    const list = await cf(env, t, `/accounts/${accountId}/d1/database?name=${DB_NAME}`);
    const found = list.find((d) => d.name === DB_NAME);
    if (found) return { databaseId: found.uuid, updating: true };
    const made = await cf(env, t, `/accounts/${accountId}/d1/database`, json({ name: DB_NAME }));
    return { databaseId: made.uuid, updating: false };
  },

  // データの表。済んだものは飛ばす（wrangler と同じ d1_migrations で記録する）
  async tables(env, t, { accountId, databaseId }) {
    const q = (sql, params) => cf(env, t, `/accounts/${accountId}/d1/database/${databaseId}/query`, json({ sql, params }));
    await q(`CREATE TABLE IF NOT EXISTS d1_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    const done = new Set((await q("SELECT name FROM d1_migrations"))[0].results.map((r) => r.name));
    for (const m of BUNDLE.migrations) {
      if (done.has(m.name)) continue;
      await q(m.sql);
      await q("INSERT INTO d1_migrations (name) VALUES (?)", [m.name]);
    }
    return {};
  },

  // ファイル置き場
  async storage(env, t, { accountId }) {
    const list = await cf(env, t, `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
    const found = list.find((n) => n.title === KV_TITLE);
    if (found) return { kvId: found.id };
    const made = await cf(env, t, `/accounts/${accountId}/storage/kv/namespaces`, json({ title: KV_TITLE }));
    return { kvId: made.id };
  },

  // 画面のファイルを送る
  async screens(env, t, { accountId }) {
    const manifest = Object.fromEntries(BUNDLE.assets.map((a) => [a.path, { hash: a.hash, size: a.size }]));
    const session = await cf(env, t, `/accounts/${accountId}/workers/scripts/${WORKER}/assets-upload-session`, json({ manifest }));
    let jwt = session.jwt;
    for (const bucket of session.buckets || []) {
      const form = new FormData();
      for (const hash of bucket) {
        const a = BUNDLE.assets.find((x) => x.hash === hash);
        form.append(hash, new File([a.base64], hash, { type: a.type }));
      }
      const r = await cf(env, session.jwt, `/accounts/${accountId}/workers/assets/upload?base64=true`, { method: "POST", body: form });
      if (r?.jwt) jwt = r.jwt;
    }
    return { assetsJwt: jwt };
  },

  // サイト本体を置いて、住所で開けるようにする
  async site(env, t, { accountId, databaseId, kvId, assetsJwt }) {
    const metadata = {
      main_module: BUNDLE.mainModule,
      compatibility_date: BUNDLE.compatibilityDate,
      bindings: [
        { type: "kv_namespace", name: "SOURCE_FILES", namespace_id: kvId },
        { type: "d1", name: "DB", id: databaseId },
        { type: "ai", name: "AI" },
        { type: "assets", name: "ASSETS" },
      ],
      keep_bindings: ["secret_text", "secret_key"],
      assets: { jwt: assetsJwt, config: BUNDLE.assetsConfig },
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append(BUNDLE.mainModule, new File([BUNDLE.script], BUNDLE.mainModule, { type: "application/javascript+module" }));
    await cf(env, t, `/accounts/${accountId}/workers/scripts/${WORKER}`, { method: "PUT", body: form });
    await cf(env, t, `/accounts/${accountId}/workers/scripts/${WORKER}/subdomain`, json({ enabled: true, previews_enabled: false }));
    return {};
  },

  // できたサイトが開けるようになったか
  async live(env, _t, { subdomain }) {
    const url = `https://${WORKER}.${subdomain}.workers.dev`;
    try {
      const res = await fetch((env.LIVE_BASE || url) + "/api/auth/state", { headers: { Accept: "application/json" } });
      return { url, live: res.ok };
    } catch {
      return { url, live: false };
    }
  },
};

function validate(body) {
  for (const k of ["accountId", "databaseId", "kvId"])
    if (body[k] != null && !ID.test(body[k])) return false;
  if (body.subdomain != null && !SUB.test(body.subdomain)) return false;
  if (body.siteName != null && !SITE_NAME.test(body.siteName)) return false;
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/step") return env.ASSETS.fetch(request);
    const reply = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

    if (request.method !== "POST") return reply({ ok: false }, 405);
    if (request.headers.get("Origin") !== url.origin) return reply({ ok: false }, 403);

    const body = await request.json().catch(() => null);
    const step = body && Object.hasOwn(STEPS, body.step) ? STEPS[body.step] : null;
    const token = String(body?.token || "").trim();
    if (!step || !validate(body)) return reply({ ok: false, kind: "other", message: "うまく受け取れませんでした。ページを開き直してください。" }, 400);
    if (body.step !== "live" && !/^[A-Za-z0-9_-]{20,}$/.test(token))
      return reply({ ok: false, kind: "key", message: "鍵の文字がうまく貼り付けられていないようです。もう一度コピーして貼り付けてください。" });

    try {
      return reply({ ok: true, ...(await step(env, token, body)) });
    } catch (e) {
      return reply({ ok: false, ...friendly(e), code: e.code ?? null });
    }
  },
};
