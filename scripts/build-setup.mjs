// ツール本体を1つのファイルにまとめて、設置ページに持たせる
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
// wrangler が送るものと同じ種類名にする
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

const config = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));

const out = mkdtempSync(join(tmpdir(), "team-hub-bundle-"));
execFileSync(join(ROOT, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", out], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
const script = readFileSync(join(out, "index.js"), "utf8");
rmSync(out, { recursive: true, force: true });

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const pub = join(ROOT, config.assets.directory);
const assets = walk(pub).filter((p) => !p.endsWith(".DS_Store")).map((p) => {
  const bytes = readFileSync(p), base64 = bytes.toString("base64"), ext = extname(p);
  return {
    path: "/" + relative(pub, p).split(sep).join("/"),
    hash: createHash("sha256").update(base64 + ext.slice(1)).digest("hex").slice(0, 32),
    size: bytes.length,
    type: TYPES[ext] || "application/octet-stream",
    base64,
  };
});

const migDir = join(ROOT, "migrations");
const migrations = readdirSync(migDir).filter((n) => n.endsWith(".sql")).sort()
  .map((name) => ({ name, sql: readFileSync(join(migDir, name), "utf8") }));

const bundle = {
  mainModule: "index.js",
  compatibilityDate: config.compatibility_date,
  assetsConfig: { not_found_handling: config.assets.not_found_handling, run_worker_first: config.assets.run_worker_first },
  script, assets, migrations,
};
writeFileSync(join(ROOT, "setup/src/app-bundle.js"), "export default " + JSON.stringify(bundle) + ";\n");
console.log(`まとめました: 本体 ${(script.length / 1024) | 0}KB / 画面 ${assets.length}ファイル / 表 ${migrations.length}件`);
