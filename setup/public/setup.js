// 設置ページの画面。1画面に1つのことだけ頼む。鍵はこのページを閉じれば消える（どこにも保存しない）
const $app = document.getElementById("app");

const PERMS = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "account_settings", type: "read" },
];
const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys="
  + encodeURIComponent(JSON.stringify(PERMS)) + "&accountId=*&zoneId=all&name=" + encodeURIComponent("team-hub-setup");
const TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";
const SIGNUP = "https://dash.cloudflare.com/sign-up";

const TASKS = [
  ["address", "サイトの住所を用意しています"],
  ["database", "データの置き場を作っています"],
  ["tables", "データの置き場を整えています"],
  ["storage", "ファイルの置き場を作っています"],
  ["screens", "画面を送っています"],
  ["site", "サイトを組み立てています"],
];

const s = { token: "", accountId: null, accounts: [], work: {}, doneTo: 0, url: "", updating: false };

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const isMac = /Mac/.test(navigator.platform);

async function step(name, extra = {}) {
  let res;
  try {
    res = await fetch("/api/step", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: name, token: s.token, accountId: s.accountId, ...s.work, ...extra }),
    });
  } catch {
    return { ok: false, kind: "net", message: "インターネットにつながらないようです。つながっているか確かめて、もう一度押してください。" };
  }
  return res.json().catch(() => ({ ok: false, kind: "other", message: "うまくいきませんでした。もう一度押してください。" }));
}

function page(n, html) {
  $app.innerHTML = `${n ? `<div class="progress">全部で3つのうち ${n} つめ</div>` : ""}<div class="card">${html}</div>`;
  window.scrollTo(0, 0);
  $app.querySelector("h1")?.focus?.();
}
const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

function welcome() {
  page(0, `<h1>チーム管理ツールを、あなた専用に作ります</h1>
    <p>タスク・カレンダー・議事録をまとめるツールです。会議を録音すると、自動で文字にできます。</p>
    <p>このページの案内どおりに、3つのことをするだけです。パソコンに何かを入れることはありません。</p>
    <div class="note"><b>はじめる前に</b><br>
      ・パソコンのGoogle Chromeで開いてください（スマホではできません）<br>
      ・作るのはチームで1人だけです。ほかの方は、あとで招待リンクから入れます<br>
      ・費用はかかりません。クレジットカードの入力を求められたら、入力せずに止めて、教えてくれた人に聞いてください</div>
    <button class="btn" id="go">はじめる</button>`);
  on("go", signup);
}

function signup() {
  page(1, `<h1>Cloudflare（クラウドフレア）に登録します</h1>
    <p>ツールを置いておく場所です。無料で使えます。</p>
    <ol class="do">
      <li>下の緑のボタンを押すと、登録のページが別のタブで開きます。</li>
      <li>メールアドレスとパスワードを入れて登録します。</li>
      <li>Cloudflareからメールが届きます。メールを開いて、確認のボタンを押します。<br><span class="small">迷惑メールに入っていることがあります。</span></li>
      <li>終わったら、このタブに戻ってきて「登録できました」を押します。</li>
    </ol>
    <a class="btn" href="${SIGNUP}" target="_blank" rel="noopener">登録のページを開く</a>
    <button class="btn sub" id="next">登録できました</button>
    <button class="btn sub" id="have">もう登録してあります</button>
    <button class="back" id="back">ひとつ前に戻る</button>`);
  on("next", key); on("have", key); on("back", welcome);
}

function key(message) {
  page(2, `<h1>「鍵」を作って、ここに貼り付けます</h1>
    <p>このページがあなたの代わりにツールを作るための、合鍵のようなものです。</p>
    ${typeof message === "string" ? `<div class="err">${esc(message)}</div>` : ""}
    <ol class="do">
      <li>下の緑のボタンを押します。Cloudflareの画面が別のタブで開きます。<br>
        <a class="btn" href="${TOKEN_URL}" target="_blank" rel="noopener">鍵を作る画面を開く</a>
        <span class="small">ログインの画面が出たら、登録したメールアドレスとパスワードを入れます。<br>
        「新しいものを出荷する」「ドメインを追加する」などを選ぶ画面が出たら、何も選びません。このタブに戻って、緑のボタンをもう一度押します。</span></li>
      <li>画面をいちばん下まで動かして、<b class="label">Continue to summary</b>（続ける）を押します。<br><span class="small">日本語で表示されていたら、同じ位置のボタンを押します。ほかの欄は変えません。</span></li>
      <li><b class="label">Create Token</b>（トークンを作成）を押します。</li>
      <li>長い文字が出ます。その横の<b class="label">Copy</b>（コピー）を押します。</li>
      <li>このタブに戻って、下の「貼り付ける」を押します。</li>
    </ol>
    <button class="btn sub" id="paste">貼り付ける</button>
    <textarea id="token" aria-label="鍵" placeholder="ここに鍵が入ります" autocomplete="off" spellcheck="false">${esc(s.token)}</textarea>
    <div id="keyMsg"></div>
    <button class="btn" id="check">この鍵で進む</button>
    <details><summary>鍵は安全ですか？</summary>
      <p class="small">鍵は、ツールを作る間だけ使います。保存はしません。この鍵でできるのはツールを置くことだけで、お金の支払いやパスワードの変更はできません。完成の画面で、消し方もご案内します。</p></details>
    <button class="back" id="back">ひとつ前に戻る</button>`);
  const box = document.getElementById("token"), msg = document.getElementById("keyMsg");
  on("paste", async () => {
    try { box.value = await navigator.clipboard.readText(); check(); }
    catch { msg.innerHTML = `<div class="note">自動で貼り付けできませんでした。白い四角の中を押して、${isMac ? "「command」と「V」" : "「Ctrl」と「V」"}を同時に押してください。</div>`; box.focus(); }
  });
  on("back", signup);
  on("check", check);
  async function check() {
    const btn = document.getElementById("check");
    s.token = box.value.trim().replace(/^["'`]|["'`]$/g, "");
    if (!s.token) { msg.innerHTML = `<div class="note">まだ鍵が入っていません。Cloudflareの画面で「Copy」を押してから、「貼り付ける」を押してください。</div>`; return; }
    btn.disabled = true; btn.textContent = "確かめています…"; msg.innerHTML = "";
    const r = await step("check");
    btn.disabled = false; btn.textContent = "この鍵で進む";
    if (!r.ok) { msg.innerHTML = `<div class="err">${esc(r.message)}</div>`; return; }
    s.accounts = r.accounts;
    if (r.accounts.length === 1) { s.accountId = r.accounts[0].id; place(); }
    else chooseAccount();
  }
}

function chooseAccount() {
  page(2, `<h1>どのアカウントに作りますか？</h1>
    <p>アカウントが複数あります。迷ったら、いちばん上のままで大丈夫です。</p>
    ${s.accounts.map((a, i) => `<label class="acct"><input type="radio" name="acct" value="${esc(a.id)}" ${i === 0 ? "checked" : ""}> ${esc(a.name)}</label>`).join("")}
    <button class="btn" id="next">このアカウントに作る</button>`);
  on("next", () => { s.accountId = document.querySelector("input[name=acct]:checked").value; place(); });
}

// 住所の名前を選べるアカウントなら名前の画面へ。途中まで作ってあるときは、住所はもう決まっている
async function place() {
  if (s.doneTo > 0) return build();
  page(3, `<h1>確かめています…</h1>`);
  const r = await step("place");
  if (!r.ok) {
    if (r.kind === "key") { s.token = ""; return key(r.message); }
    page(3, `<h1>うまくいきませんでした</h1><div class="err">${esc(r.message)}</div><button class="btn" id="again">もう一度押す</button>`);
    return on("again", place);
  }
  if (r.canName) nameForm();
  else build();
}

function nameForm(message) {
  s.siteName ||= "team-" + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  page(3, `<h1>サイトの住所の名前を決めます</h1>
    <p>住所に入る名前です。招待した人にも見えるので、メールアドレスや本名は入れないでください。</p>
    <p>入っている名前のままでも使えます。</p>
    ${message ? `<div class="err">${esc(message)}</div>` : ""}
    <label for="siteName"><b>名前</b></label>
    <input type="text" id="siteName" value="${esc(s.siteName)}" maxlength="32" autocomplete="off" autocapitalize="off" spellcheck="false">
    <p class="small">半角の英語の小文字・数字・「-」で、32文字まで。例：sakura-team</p>
    <p>できあがる住所</p>
    <span class="url" id="preview"></span>
    <div id="nameMsg"></div>
    <button class="btn" id="next">この名前で進む</button>`);
  const box = document.getElementById("siteName"), preview = document.getElementById("preview");
  const value = () => box.value.normalize("NFKC").trim().toLowerCase();
  const show = () => { preview.textContent = `https://team-hub.${value() || "…"}.workers.dev`; };
  box.oninput = show;
  show();
  on("next", () => {
    if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(value())) {
      document.getElementById("nameMsg").innerHTML = `<div class="note">使えるのは、半角の英語の小文字・数字・「-」だけです。「-」は最初と最後には使えません。</div>`;
      return box.focus();
    }
    s.siteName = value();
    build();
  });
}

function build() {
  page(3, `<h1>ツールを作ります</h1>
    <p>ボタンを押すと、自動で進みます。終わるまでこの画面を閉じないでください。</p>
    <ul class="tasks" id="tasks">${TASKS.map(([k, label]) => `<li data-k="${k}">${label}</li>`).join("")}<li data-k="live">開けるようになるのを待っています</li></ul>
    <div id="buildMsg"></div>
    <button class="btn" id="run">作る</button>
    ${s.siteName && !s.doneTo ? `<button class="back" id="back">住所の名前を変える</button>` : ""}`);
  paint();
  on("run", run);
  on("back", () => nameForm());
}

function paint(doing) {
  const keys = [...TASKS.map((t) => t[0]), "live"];
  document.querySelectorAll("#tasks li").forEach((li) => {
    const i = keys.indexOf(li.dataset.k);
    li.className = i < s.doneTo ? "done" : li.dataset.k === doing ? "doing" : "";
  });
}

async function run() {
  const btn = document.getElementById("run"), msg = document.getElementById("buildMsg");
  btn.disabled = true; btn.textContent = "作っています…"; msg.innerHTML = "";
  document.getElementById("back")?.remove();
  for (let i = s.doneTo; i < TASKS.length; i++) {
    const [name] = TASKS[i];
    paint(name);
    const r = await step(name, name === "address" ? { siteName: s.siteName } : {});
    if (!r.ok) return fail(r, btn, msg);
    const { ok, ...rest } = r;
    if (name === "database") s.updating = rest.updating;
    Object.assign(s.work, rest);
    s.doneTo = i + 1;
  }
  paint("live");
  for (let i = 0; i < 40; i++) {
    const r = await step("live");
    if (r.url) s.url = r.url;
    if (r.ok && r.live) return finish();
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  // サイトはできているが、まだ開けない。住所が使えるまで時間がかかることがある
  finish(true);
}

function fail(r, btn, msg) {
  if (r.kind === "key") { s.token = ""; return key(r.message); }
  if (r.kind === "name") return nameForm(r.message);
  msg.innerHTML = `<div class="err">${esc(r.message)}${r.code ? `<br><span class="small">（番号：${esc(r.code)}）</span>` : ""}</div>`;
  btn.disabled = false; btn.textContent = "もう一度押す";
  paint();
}

function finish(slow) {
  s.token = "";
  page(0, `<h1>🎉 ${s.updating ? "新しい版にしました" : "できました！"}</h1>
    ${s.updating ? `<p>これまでのデータは、そのまま残っています。</p>` : ""}
    ${slow ? `<div class="note">サイトが開けるようになるまで、少し時間がかかることがあります。開けないときは、10分ほど待ってからもう一度開いてください。</div>` : ""}
    <p>これが、あなたのツールの住所です。</p>
    <span class="url" id="url">${esc(s.url)}</span>
    ${s.work.nameKept ? `<div class="note">決めていただいた名前には変えられなかったので、今の住所のまま作りました。名前を変えるときは、Cloudflareの「Workers &amp; Pages」で「Your subdomain」の横の「Change」を押します。メンバーを招待する前に変えてください。</div>` : ""}
    <a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">ツールを開く</a>
    <button class="btn sub" id="copy">住所をコピーする</button>
    ${s.updating ? "" : `<div class="note"><b>開いたら、すぐにしてください</b><br>
      ・「はじめての設定」を済ませます。<b>最初に設定した人が管理者になります</b><br>
      ・ブックマークします（${isMac ? "「command」と「D」" : "「Ctrl」と「D」"}を同時に押します）</div>`}
    <details><summary>念のため、鍵を消す（おすすめ）</summary>
      <p class="small">もう鍵は使いません。下のボタンでCloudflareの画面を開き、<b>team-hub-setup</b> の行の「…」から「Delete（削除）」を押すと消えます。消してもツールはそのまま使えます。新しい版にするときは、また作れば大丈夫です。</p>
      <a class="btn sub" href="${TOKENS_PAGE}" target="_blank" rel="noopener">鍵の一覧を開く</a></details>`);
  on("copy", async (e) => {
    try { await navigator.clipboard.writeText(s.url); e.target.textContent = "✓ コピーしました"; }
    catch { e.target.textContent = "コピーできませんでした。上の住所をメモしてください"; }
  });
}

window.addEventListener("beforeunload", (e) => { if (document.querySelector("#run:disabled")) e.preventDefault(); });
welcome();
