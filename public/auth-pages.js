// ログインまわりの画面: 最初の設定 / ログイン / 招待リンク(パスワード再設定) / 設定
import { api, esc, APP } from "./common.js";

const RULE = "ログインIDは半角英数字で3〜32文字、パスワードは8文字以上です。";
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const addMonths = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

// フォームを送って、成功したらページを開き直す
function bindForm($app, id, send) {
  const f = $app.querySelector("#" + id), msg = $app.querySelector("#authMsg");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    if ("password2" in data && data.password !== data.password2) { msg.textContent = "パスワードが2回とも同じになっていません"; return; }
    const btn = f.querySelector("button");
    btn.disabled = true; msg.textContent = "";
    try { await send(data); }
    catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
}

const pwFields = `<label class="fld"><span>パスワード</span><input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
  <label class="fld"><span>パスワード（確認）</span><input name="password2" type="password" autocomplete="new-password" required></label>`;

// ---- Googleログインのボタン ----
let gisLoading = null;
const loadGis = () => gisLoading ||= new Promise((ok, ng) => {
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.onload = ok;
  s.onerror = () => { gisLoading = null; ng(new Error("Googleのボタンを読み込めませんでした。ページを開き直してください")); };
  document.head.append(s);
});

// box の中にボタンを出す。押して本人と確かめられたら send(credential) を呼ぶ
async function googleButton(box, clientId, msg, send) {
  try {
    await loadGis();
    google.accounts.id.initialize({ client_id: clientId, callback: async (r) => {
      msg.textContent = "";
      try { await send(r.credential); } catch (err) { msg.textContent = err.message; }
    } });
    box.innerHTML = "";
    google.accounts.id.renderButton(box, { theme: "outline", size: "large", text: "continue_with", locale: "ja", width: 280 });
  } catch (err) { msg.textContent = err.message; }
}

// Googleの設定の手順。作る人がこのとおりに進めて、クライアントIDを持って帰ってくる
const CLIENT_PAGE = "https://console.cloud.google.com/auth/clients";
const originBox = () => `<div class="gorigin"><code>${esc(location.origin)}</code> <button type="button" class="btn sub mini" id="copyOrigin">コピー</button></div>`;
const GOOGLE_STEPS = [
  { title: "Google Cloud にプロジェクトを作る", url: "https://console.cloud.google.com/projectcreate",
    body: () => `<p>開いた画面で、名前はそのままで「作成」を押します。はじめての方は、先に利用規約の同意が出ます。</p><p>作ったあと、画面の上にそのプロジェクトの名前が出ていれば大丈夫です。</p>` },
  { title: "Googleログインの画面を用意する", url: "https://console.cloud.google.com/auth/overview",
    body: () => `<p>「開始」を押して、順に入れます。</p><ul><li>アプリ名：<b>team-hub</b></li><li>メール：ご自身のアドレスを選ぶ</li><li>対象：<b>外部</b></li></ul><p>最後まで進めて「作成」を押します。</p>` },
  { title: "メンバーも使えるようにする", url: "https://console.cloud.google.com/auth/audience",
    body: () => `<p>「アプリを公開」を押して、確認の画面でも進めます。</p><p>これを押さないと、招待したメンバーがログインできません。</p>` },
  { title: "このツールを登録する", url: `${CLIENT_PAGE}/create`,
    body: () => `<p>種類は「<b>ウェブ アプリケーション</b>」を選びます。</p><p>「承認済みの JavaScript 生成元」の「URI を追加」を押して、次のURLを貼り付けます。</p>${originBox()}<p>最後に「作成」を押します。出てきた「クライアント ID」をコピーしてください。</p>` },
];
const googleSteps = () => `<ol class="gsteps small">${GOOGLE_STEPS.map((s) =>
  `<li><a href="${s.url}" target="_blank" rel="noopener">${s.title}</a>${s.body()}</li>`).join("")}<li>コピーした「クライアント ID」を下に貼り付けます。</li></ol>`;

function bindCopyOrigin($app) {
  const b = $app.querySelector("#copyOrigin");
  if (b) b.onclick = async () => { await navigator.clipboard.writeText(location.origin); b.textContent = "✓ コピーしました"; };
}

// クライアントIDが貼られたらボタンを出す
function bindClientId($app, input, box, msg, send) {
  const show = () => {
    const id = input.value.trim();
    box.innerHTML = "";
    if (!id) return;
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) { msg.textContent = "クライアントIDは「.apps.googleusercontent.com」で終わる文字です。全部コピーできているか確かめてください"; return; }
    msg.textContent = "";
    googleButton(box, id, msg, (credential) => send(credential, id));
  };
  input.oninput = show;
  bindCopyOrigin($app);
}

// Googleのボタンでエラーになるとき(ドメインを変えたあとなど)の案内
const googleHelp = `<details class="small"><summary>Googleのボタンでエラーが出るとき（ツールを作った方へ）</summary>
    <p>ドメインを変えたあとは、Googleの設定にも新しいURLを足す必要があります。<a href="${CLIENT_PAGE}" target="_blank" rel="noopener">クライアントの画面</a>で作ったクライアントを開き、「承認済みの JavaScript 生成元」に <code>${esc(location.origin)}</code> を追加して保存してください。反映まで少しかかることがあります。</p></details>`;

// 設置ページで作ったサイトを、完成の画面のリンク以外から開いたとき
export function renderNeedClaim($app) {
  $app.innerHTML = `<div class="authbox card">
    <h1>まだ準備中です</h1>
    <p>管理者の設定は、このツールを作った方だけができます。</p>
    <p class="small"><b>作った方へ：</b>設置ページの完成の画面にある「ツールを開く」から開いてください。画面を閉じてしまったときは、設置ページをはじめから進めると、もう一度その画面が出ます。データは消えません。</p>
    <p class="small"><b>招待された方へ：</b>作った方の設定が終わると、招待リンクが届きます。</p></div>`;
}

export function renderSetup($app, claim = "") {
  const t = today();
  const info = { project_name: "", name: "", short_name: "", start_date: t, end_date: addMonths(t, 6) };
  const total = GOOGLE_STEPS.length + 1;
  const send = async (extra) => {
    await api("/api/auth/setup", { method: "POST", body: JSON.stringify({ ...info, claim, ...extra }) });
    location.hash = "#/"; location.reload();
  };
  const show = (html) => { $app.innerHTML = `<div class="authbox card">${html}</div>`; window.scrollTo(0, 0); };

  // 1. 名前を入れる
  const names = () => {
    show(`<h1>はじめての設定</h1>
      <p class="small">入れた人が<b>管理者</b>になります。ほかの方は、あとで招待リンクから入れます。</p>
      <form id="namesForm">
        <label class="fld"><span>チームやプロジェクトの名前</span><input name="project_name" required value="${esc(info.project_name)}" placeholder="例：秋のイベント出店チーム"></label>
        <label class="fld"><span>あなたの呼び名</span><input name="name" required value="${esc(info.name)}" placeholder="例：たろう"></label>
        <div id="authMsg" class="late"></div><button class="btn">次へ</button>
      </form>`);
    bindForm($app, "namesForm", async (d) => { Object.assign(info, d); intro(); });
  };

  // 2. これから何をするかを伝える
  const intro = () => {
    show(`<h1>Googleログインの準備</h1>
      <p>ご自身のGoogleアカウントで、このツール専用のログインの入口を作ります。ツールを作る方が最初に1回だけします。</p>
      <p class="small">無料です。メンバーの方はこの作業をしなくても、招待リンクからGoogleのボタンを押すだけで入れます。</p>
      <p class="small">このあとの画面でボタンを押すと、Googleの画面が新しいタブで開きます。終わったら、このタブに戻ってきてください。</p>
      <div class="gnav"><button class="btn" id="next">はじめる</button><button class="btn sub" id="back">もどる</button></div>`);
    $app.querySelector("#next").onclick = () => step(0);
    $app.querySelector("#back").onclick = names;
  };

  // 3. 手順を1つずつ出す
  const step = (i) => {
    const s = GOOGLE_STEPS[i];
    show(`<p class="small muted">手順 ${i + 1} / ${total}</p><h1>${s.title}</h1>
      <a class="btn" href="${s.url}" target="_blank" rel="noopener">Googleの画面を開く</a>
      <div class="gbody">${s.body()}</div>
      <div class="gnav"><button class="btn" id="next">できたので次へ</button><button class="btn sub" id="back">もどる</button></div>`);
    bindCopyOrigin($app);
    $app.querySelector("#next").onclick = () => i + 1 < GOOGLE_STEPS.length ? step(i + 1) : last();
    $app.querySelector("#back").onclick = () => i ? step(i - 1) : intro();
  };

  // 4. クライアントIDを貼ってGoogleで入る
  const last = () => {
    show(`<p class="small muted">手順 ${total} / ${total}</p><h1>Googleで管理者になる</h1>
      <label class="fld"><span>コピーした「クライアント ID」を貼り付けてください</span><input id="clientId" autocomplete="off" autocapitalize="off" placeholder="○○○.apps.googleusercontent.com"></label>
      <p class="small">貼り付けるとボタンが出ます。管理者にするGoogleアカウントを選んでください。</p>
      <div id="googleBox" class="gbox"></div><div id="authMsg" class="late"></div>
      <p class="small muted">エラーが出たら、数分待ってからもう一度ボタンを押してください。登録の反映に少し時間がかかることがあります。</p>
      <div class="gnav"><button class="btn sub" id="back">もどる</button></div>
      <details class="small"><summary>Googleの準備がどうしてもできないとき</summary>
        <form id="pwForm">
          <p class="muted">ログインIDとパスワードではじめられます。あとから「設定」でGoogleログインに切り替えられます。</p>
          <label class="fld"><span>ログインID（半角の英語と数字で3文字以上）</span><input name="login_id" required autocomplete="username" autocapitalize="off" pattern="[A-Za-z0-9_.\\-]{3,32}" placeholder="例：taro01"></label>
          ${pwFields}
          <button class="btn">IDとパスワードではじめる</button>
        </form></details>`);
    bindClientId($app, $app.querySelector("#clientId"), $app.querySelector("#googleBox"), $app.querySelector("#authMsg"),
      (credential, id) => send({ credential, google_client_id: id }));
    bindForm($app, "pwForm", (d) => send(d));
    $app.querySelector("#back").onclick = () => step(GOOGLE_STEPS.length - 1);
  };
  names();
}

export function renderLogin($app, clientId = null, hasPassword = true) {
  const form = `<form id="loginForm">
      <label class="fld"><span>ログインID</span><input name="login_id" required autocomplete="username"></label>
      <label class="fld"><span>パスワード</span><input name="password" type="password" required autocomplete="current-password"></label>
      <button class="btn">ログイン</button>
    </form>`;
  $app.innerHTML = `<div class="authbox card">
    <h1>ログイン</h1>
    ${clientId ? `<div id="googleBox" class="gbox"></div><div id="authMsg" class="late"></div>
      ${hasPassword ? `<details class="small"><summary>ログインIDとパスワードで入る</summary>${form}</details>` : ""}` : `${form}<div id="authMsg" class="late"></div>`}
    <p class="muted small">はじめての人は、記録係から届いた招待リンクを開いてください。${clientId ? "" : "パスワードを忘れたときは、記録係に再設定リンクを作ってもらってください。"}</p>
    ${clientId ? googleHelp : ""}</div>`;
  const done = () => { location.hash = "#/"; location.reload(); };
  if (!clientId || hasPassword) bindForm($app, "loginForm", async (d) => {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify(d) });
    done();
  });
  if (clientId) googleButton($app.querySelector("#googleBox"), clientId, $app.querySelector("#authMsg"), async (credential) => {
    await api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential }) });
    done();
  });
}

export async function renderInvite($app, token) {
  let inv;
  try { inv = await api(`/api/auth/invite/${encodeURIComponent(token)}`); }
  catch (err) { $app.innerHTML = `<div class="notice"><h1>このリンクは使えません</h1><p>${esc(err.message)}</p><p><a href="#/">ログイン画面へ</a></p></div>`; return; }
  const g = inv.googleClientId;
  const showForm = g ? inv.loginId : (!inv.reset || inv.loginId); // Googleログインのツールでは、パスワードを持つ人の再設定にだけ欄を出す
  const form = !showForm ? "" : `<form id="inviteForm">
      ${inv.loginId ? `<p class="small">ログインID：<b>${esc(inv.loginId)}</b></p>`
        : `<label class="fld"><span>ログインID</span><input name="login_id" required autocomplete="username" pattern="[A-Za-z0-9_.\\-]{3,32}"></label>`}
      ${pwFields}
      <p class="muted small">${RULE}</p>
      <button class="btn">${inv.reset ? "パスワードを変えてログイン" : "登録してはじめる"}</button>
    </form>`;
  const lead = g ? (inv.reset ? "の入り直しです。Googleのボタンを押してください。" : "として参加します。Googleのボタンを押すだけで入れます。")
    : (inv.reset ? "の新しいパスワードを決めてください。" : "として参加します。ログインIDとパスワードを決めてください。");
  $app.innerHTML = `<div class="authbox card">
    <h1>${inv.reset ? (g ? "ログインのやり直し" : "パスワードの再設定") : "ようこそ"}</h1>
    <p>${esc(inv.project)} の <b>${esc(inv.name)}</b> さん${lead}</p>
    ${g ? `<div id="googleBox" class="gbox"></div>` : ""}
    <div id="authMsg" class="late"></div>
    ${g && form ? `<details class="small"><summary>パスワードを決め直す</summary>${form}</details>` : form}
    ${g ? googleHelp : ""}</div>`;
  const send = async (d) => {
    await api(`/api/auth/invite/${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify(d) });
    location.hash = "#/"; location.reload();
  };
  if (form) bindForm($app, "inviteForm", send);
  if (g) googleButton($app.querySelector("#googleBox"), g, $app.querySelector("#authMsg"), (credential) => send({ credential }));
}

// 設定: 自分のパスワード / (記録係)プロジェクト名・期間
export async function renderSettings($app, me, projectId) {
  const p = me.isRecorder ? (await api(`/api/projects/${projectId}`)).project : null;
  $app.innerHTML = `<p><a href="#/">← もどる</a></p><h1>設定</h1>
    ${p ? `<div class="card authbox"><h2>プロジェクト（記録係のみ）</h2><form id="projForm">
      <label class="fld"><span>プロジェクト名</span><input name="name" value="${esc(p.name)}" required></label>
      <label class="fld"><span>チーム名（短く）</span><input name="short_name" value="${esc(p.short_name || "")}"></label>
      <div class="row"><label class="fld"><span>開始日</span><input type="date" name="start_date" value="${esc(p.start_date)}" required></label>
        <label class="fld"><span>終了日</span><input type="date" name="end_date" value="${esc(p.end_date)}" required></label></div>
      <div id="projMsg" class="small"></div><button class="btn">保存</button></form></div>` : ""}
    ${me.googleClientId || me.isOwner ? `<div class="card authbox"><h2>Googleログイン</h2>
      ${me.googleEmail ? `<p class="small">今のアカウント：<b>${esc(me.googleEmail)}</b></p>` : `<p class="small">Googleアカウントを結びつけると、次からボタンを押すだけで入れます。</p>`}
      ${me.isOwner ? `${me.googleClientId ? `<details class="small"><summary>Googleの設定をやり直す</summary>${googleSteps()}
          <label class="fld"><span>クライアント ID</span><input id="clientId" autocomplete="off" autocapitalize="off"></label></details>`
        : `${googleSteps()}<label class="fld"><span>クライアント ID</span><input id="clientId" autocomplete="off" autocapitalize="off" placeholder="○○○.apps.googleusercontent.com"></label>`}` : ""}
      <div id="googleBox" class="gbox"></div><div id="googleMsg" class="late"></div></div>` : ""}
    ${me.loginId ? `<div class="card authbox"><h2>パスワードを変える</h2>
      <p class="small">ログインID：<b>${esc(me.loginId)}</b></p>
      <form id="pwForm">
        <label class="fld"><span>今のパスワード</span><input name="current" type="password" required autocomplete="current-password"></label>
        ${pwFields}
        <div id="authMsg" class="late"></div><button class="btn">変える</button></form></div>` : ""}`;
  if (me.loginId) bindForm($app, "pwForm", async (d) => {
    await api("/api/me/password", { method: "POST", body: JSON.stringify(d) });
    alert("パスワードを変えました"); location.hash = "#/";
  });
  const gBox = $app.querySelector("#googleBox"), gMsg = $app.querySelector("#googleMsg");
  const linkGoogle = async (credential, id) => {
    await api("/api/me/google", { method: "POST", body: JSON.stringify({ credential, google_client_id: id || "" }) });
    alert("Googleアカウントでログインできるようになりました"); location.reload();
  };
  if (gBox && me.googleClientId) googleButton(gBox, me.googleClientId, gMsg, (credential) => linkGoogle(credential));
  const idInput = $app.querySelector("#clientId");
  if (idInput) bindClientId($app, idInput, gBox, gMsg, linkGoogle);
  const pf = $app.querySelector("#projForm");
  if (pf) pf.onsubmit = async (e) => {
    e.preventDefault();
    const msg = $app.querySelector("#projMsg");
    try {
      await api(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(pf))) });
      APP.name = pf.elements.name.value; msg.textContent = "✓ 保存しました"; location.reload();
    } catch (err) { msg.textContent = err.message; }
  };
}
