// メンバー: 自己紹介カード。全員が編集でき、記録係は追加・招待リンクの発行・名簿から外すことができる
import { api, esc } from "./common.js";

// 自己紹介カードの項目
const FIELDS = [
  ["profile_url", "プロフィールのリンク", 1],
  ["region", "住んでいる地域", 1],
  ["motivation", "参加したきっかけ・楽しみにしていること", 4],
  ["can_help", "手伝えそうなこと", 4],
  ["want_to_do", "やってみたいこと・経験してみたいこと", 4],
  ["involvement", "希望する関わり方", 3],
  ["message", "ひとこと", 3],
  ["duty_plan", "担当案", 1],
  ["duty_fixed", "確定担当", 1],
];

const st = { view: "card", editing: null, adding: false, link: null };

function valueHtml(m, key) {
  const v = m[key] || "";
  if (!v) return `<span class="muted">未記入</span>`;
  if (key === "profile_url") return /^https?:\/\//.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">プロフィールを見る ↗</a>` : esc(v);
  return `<div class="pre">${esc(v)}</div>`;
}

function card(m, me) {
  const title = m.display_name || m.name;
  const tags = `${m.is_owner ? `<span class="tag">管理者</span>` : ""}${m.is_recorder ? `<span class="tag g">記録係</span>` : ""}${m.id === me.memberId ? `<span class="tag gray">自分</span>` : ""}${me.isRecorder && !m.has_account ? `<span class="tag y">未登録</span>` : ""}`;
  if (st.editing === m.id) {
    const rows = FIELDS.map(([k, label, rows]) => `<tr><th>${label}</th><td>${rows > 1
      ? `<textarea name="${k}" rows="${rows}">${esc(m[k] || "")}</textarea>`
      : `<input name="${k}" value="${esc(m[k] || "")}">`}</td></tr>`).join("");
    return `<form class="mcard editing" data-member="${m.id}" onsubmit="return false">
      <div class="mhead"><div class="grow"><div class="label">名前（表示名）</div><input name="display_name" value="${esc(m.display_name || "")}" placeholder="例：ニックネーム＋ひとこと">
        <div class="label" style="margin-top:8px">名簿での呼び名（出欠・タスクの担当に使う短い名前）</div><input name="name" value="${esc(m.name)}"></div></div>
      <table class="mtable">${rows}</table>
      <div class="mfoot">
        <button type="button" class="btn" data-save="${m.id}">保存</button>
        <button type="button" class="btn sub" data-cancel="1">キャンセル</button>
        ${me.isRecorder ? `<label class="small"><input type="checkbox" name="is_recorder" ${m.is_recorder ? "checked" : ""} ${m.is_owner ? "disabled" : ""}> 記録係にする</label>
          <span class="grow"></span>${m.is_owner ? "" : `<button type="button" class="btn danger" data-remove="${m.id}">名簿から外す</button>`}` : ""}
      </div></form>`;
  }
  const rows = FIELDS.map(([k, label]) => `<tr><th>${label}</th><td>${valueHtml(m, k)}</td></tr>`).join("");
  return `<div class="mcard" data-member="${m.id}">
    <div class="mhead"><div class="grow"><div class="label">名前</div><div class="mname">${esc(title)}${tags}</div></div>
      ${me.isRecorder && m.id !== me.memberId ? `<button class="btn sub" data-invite="${m.id}">${m.has_account ? "🔑 再設定リンク" : "✉️ 招待リンク"}</button>` : ""}
      <button class="btn sub" data-edit="${m.id}">編集</button></div>
    ${st.link?.id === m.id ? `<div class="invitelink"><div class="small">${m.has_account ? "パスワード再設定" : "招待"}リンク（${st.link.days}日間・1回だけ使えます）。コピーして本人だけに送ってください。</div>
      <div class="row"><input class="wide" readonly value="${esc(st.link.url)}"><button class="btn" data-copylink="1">コピー</button></div></div>` : ""}
    <table class="mtable">${rows}</table></div>`;
}

function table(members) {
  const cut = (s, n = 40) => esc((s || "").replace(/\s+/g, " ").slice(0, n)) + ((s || "").length > n ? "…" : "");
  const rows = members.map((m) => `<tr class="clickrow" data-open="${m.id}"><td><b>${esc(m.name)}</b>${m.is_recorder ? `<span class="tag g">記録係</span>` : ""}</td>
    <td>${cut(m.region, 16)}</td><td>${cut(m.can_help)}</td><td>${cut(m.involvement)}</td><td>${cut(m.duty_plan, 24)}</td><td>${cut(m.duty_fixed, 24)}</td></tr>`).join("");
  return `<table><tr><th style="width:130px">名前</th><th style="width:130px">地域</th><th>手伝えそうなこと</th><th>希望する関わり方</th><th style="width:150px">担当案</th><th style="width:120px">確定担当</th></tr>${rows}</table>`;
}


export async function mountMembers(box, me) {
  const members = await api("/api/members");
  const add = me.isRecorder ? (st.adding
    ? `<div class="card addmember"><div class="row"><input id="newName" placeholder="呼び名（例：たき）"><input id="newDisplay" class="wide" placeholder="名前（表示名・あとで編集できます）">
        <button class="btn" id="addMember">追加</button><button class="btn sub" id="cancelAdd">やめる</button></div></div>`
    : `<button class="btn" id="openAdd">＋ メンバーを追加</button>`) : "";
  box.innerHTML = `
    <div class="row mbar"><b>${members.length}人</b>
      <button class="btn sub" id="toggleView">${st.view === "card" ? "表で見る" : "カードで見る"}</button>
      <span class="grow"></span>${add}</div>
    ${st.view === "card" ? `<div class="mlayout">
      <nav class="mside"><div class="label">メンバー（押すとカードへ）</div>
        ${members.map((m) => `<button class="mjump" data-jump="${m.id}">${esc(m.name)}${m.id === me.memberId ? `<span class="muted small">（自分）</span>` : ""}</button>`).join("")}</nav>
      <div class="mcards">${members.map((m) => card(m, me)).join("")}</div></div>` : table(members)}
    ${me.isRecorder ? `<p class="muted small">新しい人は「＋ メンバーを追加」→ カードの「✉️ 招待リンク」でリンクを作り、本人に送ります。本人がリンクを開いてログインIDとパスワードを決めると使えるようになります。<br>
      パスワードを忘れた人には「🔑 再設定リンク」を送ってください。</p>` : ""}`;

  box.onclick = async (e) => {
    const t = e.target, d = t.dataset;
    try {
      if (t.id === "toggleView") { st.view = st.view === "card" ? "table" : "card"; st.editing = null; return mountMembers(box, me); }
      if (t.id === "openAdd") { st.adding = true; return mountMembers(box, me); }
      if (t.id === "cancelAdd") { st.adding = false; return mountMembers(box, me); }
      if (t.id === "addMember") {
        const m = await api("/api/members", { method: "POST", body: JSON.stringify({ name: box.querySelector("#newName").value, display_name: box.querySelector("#newDisplay").value }) });
        st.adding = false; st.view = "card"; st.editing = m.id;
        await mountMembers(box, me);
        return box.querySelector(`[data-member="${m.id}"]`)?.scrollIntoView({ behavior: "smooth" });
      }
      const jump = t.closest("[data-jump]")?.dataset.jump;
      if (jump) {
        const el = box.querySelector(`.mcard[data-member="${jump}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
        el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1500);
        return;
      }
      const open = t.closest("[data-open]");
      if (open) { st.view = "card"; st.editing = null; await mountMembers(box, me); return box.querySelector(`[data-member="${open.dataset.open}"]`)?.scrollIntoView({ behavior: "smooth" }); }
      if (d.edit) { st.editing = Number(d.edit); return mountMembers(box, me); }
      if (d.cancel) { st.editing = null; return mountMembers(box, me); }
      if (d.save) {
        const f = t.closest("form");
        const body = Object.fromEntries(["name", "display_name", ...FIELDS.map((x) => x[0])].map((k) => [k, f.elements[k].value]));
        if (me.isRecorder) body.is_recorder = f.elements.is_recorder.checked;
        await api(`/api/members/${d.save}`, { method: "PATCH", body: JSON.stringify(body) });
        st.editing = null; return mountMembers(box, me);
      }
      if (d.remove) {
        const m = members.find((x) => x.id === Number(d.remove));
        if (!confirm(`「${m.name}」さんを名簿から外しますか？\n\n・過去の議事録・出欠・タスクの名前はそのまま残ります\n・このツールにはログインできなくなります\n（あとで同じ呼び名で追加すると、名簿に戻せます）`)) return;
        await api(`/api/members/${d.remove}`, { method: "DELETE" });
        st.editing = null; return mountMembers(box, me);
      }
      if (d.invite) {
        const r = await api(`/api/members/${d.invite}/invite`, { method: "POST" });
        st.link = { id: Number(d.invite), ...r };
        await mountMembers(box, me);
        return box.querySelector(".invitelink input")?.select();
      }
      if (d.copylink) {
        await navigator.clipboard.writeText(st.link.url);
        t.textContent = "✅ コピーしました"; return;
      }
    } catch (err) { alert(err.message); }
  };
}
