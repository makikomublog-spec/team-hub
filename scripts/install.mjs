// 設置プログラム本体(Mac・Windows共通)。install.sh / install.ps1 から呼ばれる。
// 使う人のCloudflareアカウントに、データベース・ファイル置き場を用意してツールを公開する。
// もう一度実行すると「更新」になる(同じ名前のものを使い回すので、データは消えない)。
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = process.env.TEAM_HUB_WRANGLER || join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const CONFIG = "wrangler.install.jsonc";
const DB_NAME = "team-hub-db";
const KV_NAME = "team-hub-files";
const env = { ...process.env, WRANGLER_SEND_METRICS: "false" };

const say = (s) => console.log(`\n▶ ${s}`);
function fail(message, detail = "") {
  console.error(`\n✖ ${message}`);
  if (detail) console.error(detail.trim());
  console.error("\nこの画面のスクショを、ツールを教えてくれた人に見せてください。もう一度実行しても、データは消えません。");
  process.exit(1);
}

// 結果を受け取るとき
function run(args) {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" };
}
// 画面に出して、質問にも答えられるようにするとき
function runLive(args) {
  return spawnSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, env, stdio: "inherit" }).status === 0;
}
// 一覧のJSONだけを取り出す(前後に案内の文字が付くことがあるため)
function jsonList(text) {
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("一覧を読み取れませんでした");
  return JSON.parse(text.slice(start, end + 1));
}

async function login() {
  say("Cloudflareのログインを確認します");
  let me = run(["whoami", "--json"]);
  if (!me.ok) {
    console.log("ブラウザが開きます。Cloudflareにログインして「Allow（許可）」を押してください。");
    if (!runLive(["login"])) fail("Cloudflareへのログインができませんでした");
    me = run(["whoami", "--json"]);
    if (!me.ok) fail("Cloudflareへのログインを確認できませんでした", me.err);
  }
  const accounts = JSON.parse(me.out).accounts || [];
  if (!accounts.length) fail("Cloudflareのアカウントが見つかりませんでした");
  if (accounts.length === 1) return accounts[0];
  console.log("\nCloudflareのアカウントが複数あります。設置先を番号で選んでください。");
  accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const n = Number(await rl.question("番号: "));
  rl.close();
  if (!accounts[n - 1]) fail("番号が正しくありません");
  return accounts[n - 1];
}

// あれば使い回し、なければ作る
function ensure(label, list, create) {
  const found = list();
  if (found) { console.log(`${label}：前に作ったものを使います`); return found; }
  const r = create();
  if (!r.ok) fail(`${label}を作れませんでした`, r.err || r.out);
  const made = list();
  if (!made) fail(`${label}を作ったあと、見つけられませんでした`);
  console.log(`${label}：作りました`);
  return made;
}

function writeConfig(dbId, kvId) {
  const base = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
    .replace(/\s*\/\/ .*$/gm, ""));
  delete base.$schema;
  base.d1_databases = [{ binding: "DB", database_name: DB_NAME, database_id: dbId }];
  base.kv_namespaces = [{ binding: "SOURCE_FILES", id: kvId }];
  writeFileSync(join(ROOT, CONFIG), JSON.stringify(base, null, 2));
}

// 公開。結果の中からサイトのURLを探す(質問に答えられるよう、入力は画面につないだまま)
function deploy() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [WRANGLER, "deploy", "-c", CONFIG], { cwd: ROOT, env, stdio: ["inherit", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => { process.stdout.write(d); out += d; });
    p.on("close", (code) => resolve({ ok: code === 0, url: out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] || "" }));
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch {}
}

const account = await login();
env.CLOUDFLARE_ACCOUNT_ID = account.id;
console.log(`設置先：${account.name}`);

say("データベースとファイル置き場を用意します");
const listOf = (args) => { const r = run(args); if (!r.ok) fail("Cloudflareから一覧を取得できませんでした", r.err || r.out); return jsonList(r.out); };
const db = ensure("データベース", () => listOf(["d1", "list", "--json"]).find((x) => x.name === DB_NAME), () => run(["d1", "create", DB_NAME]));
const kv = ensure("ファイル置き場", () => listOf(["kv", "namespace", "list"]).find((x) => x.title === KV_NAME), () => run(["kv", "namespace", "create", KV_NAME]));
writeConfig(db.uuid, kv.id);

say("データベースの中身を整えます");
const mig = run(["d1", "migrations", "apply", "DB", "--remote", "-c", CONFIG]);
if (!mig.ok) fail("データベースの準備に失敗しました", mig.err || mig.out);

say("ツールを公開します（1分ほどかかります）");
const result = await deploy();
if (!result.ok) fail("公開に失敗しました");

console.log("\n========================================");
console.log("✅ できました！");
if (result.url) {
  console.log(`\nあなたのツールのURL：\n${result.url}\n`);
  console.log("このURLをブックマークしてください。");
  console.log("初めての場合は、すぐに開いて「はじめての設定」を済ませてください（最初に設定した人が管理者になります）。");
  openBrowser(result.url);
} else {
  console.log("\n上の表示にある「〜.workers.dev」のURLを開いてください。");
}
console.log("========================================\n");
