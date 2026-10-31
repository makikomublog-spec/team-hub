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

export function renderSetup($app) {
  const t = today();
  $app.innerHTML = `<div class="authbox card">
    <h1>はじめての設定</h1>
    <p class="small">ここを入れれば、すぐ使えます。入れた人が<b>管理者</b>になります。ほかの方は、あとで招待リンクから入れます。</p>
    <form id="setupForm">
      <label class="fld"><span>チームやプロジェクトの名前</span><input name="project_name" required placeholder="例：秋のイベント出店チーム"></label>
      <input type="hidden" name="short_name" value="">
      <input type="hidden" name="start_date" value="${t}">
      <input type="hidden" name="end_date" value="${addMonths(t, 6)}">
      <label class="fld"><span>あなたの呼び名</span><input name="name" required placeholder="例：たろう"></label>
      <label class="fld"><span>ログインID（半角の英語と数字で3文字以上）</span><input name="login_id" required autocomplete="username" autocapitalize="off" pattern="[A-Za-z0-9_.\\-]{3,32}" placeholder="例：taro01"></label>
      ${pwFields}
      <p class="muted small">パスワードは8文字以上です。ログインIDとパスワードは、忘れないように控えてください。</p>
      <div id="authMsg" class="late"></div>
      <button class="btn">はじめる</button>
    </form></div>`;
  bindForm($app, "setupForm", async (d) => {
    await api("/api/auth/setup", { method: "POST", body: JSON.stringify(d) });
    location.hash = "#/"; location.reload();
  });
}

export function renderLogin($app) {
  $app.innerHTML = `<div class="authbox card">
    <h1>ログイン</h1>
    <form id="loginForm">
      <label class="fld"><span>ログインID</span><input name="login_id" required autocomplete="username"></label>
      <label class="fld"><span>パスワード</span><input name="password" type="password" required autocomplete="current-password"></label>
      <div id="authMsg" class="late"></div>
      <button class="btn">ログイン</button>
    </form>
    <p class="muted small">はじめての人は、記録係から届いた招待リンクを開いてください。パスワードを忘れたときは、記録係に再設定リンクを作ってもらってください。</p></div>`;
  bindForm($app, "loginForm", async (d) => {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify(d) });
    location.hash = "#/"; location.reload();
  });
}

export async function renderInvite($app, token) {
  let inv;
  try { inv = await api(`/api/auth/invite/${encodeURIComponent(token)}`); }
  catch (err) { $app.innerHTML = `<div class="notice"><h1>このリンクは使えません</h1><p>${esc(err.message)}</p><p><a href="#/">ログイン画面へ</a></p></div>`; return; }
  $app.innerHTML = `<div class="authbox card">
    <h1>${inv.reset ? "パスワードの再設定" : "ようこそ"}</h1>
    <p>${esc(inv.project)} の <b>${esc(inv.name)}</b> さん${inv.reset ? "の新しいパスワードを決めてください。" : "として参加します。ログインIDとパスワードを決めてください。"}</p>
    <form id="inviteForm">
      ${inv.reset ? `<p class="small">ログインID：<b>${esc(inv.loginId)}</b></p>`
        : `<label class="fld"><span>ログインID</span><input name="login_id" required autocomplete="username" pattern="[A-Za-z0-9_.\\-]{3,32}"></label>`}
      ${pwFields}
      <p class="muted small">${RULE}</p>
      <div id="authMsg" class="late"></div>
      <button class="btn">${inv.reset ? "パスワードを変えてログイン" : "登録してはじめる"}</button>
    </form></div>`;
  bindForm($app, "inviteForm", async (d) => {
    await api(`/api/auth/invite/${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify(d) });
    location.hash = "#/"; location.reload();
  });
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
    <div class="card authbox"><h2>パスワードを変える</h2>
      <p class="small">ログインID：<b>${esc(me.loginId)}</b></p>
      <form id="pwForm">
        <label class="fld"><span>今のパスワード</span><input name="current" type="password" required autocomplete="current-password"></label>
        ${pwFields}
        <div id="authMsg" class="late"></div><button class="btn">変える</button></form></div>`;
  bindForm($app, "pwForm", async (d) => {
    await api("/api/me/password", { method: "POST", body: JSON.stringify(d) });
    alert("パスワードを変えました"); location.hash = "#/";
  });
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
