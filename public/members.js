// メンバー: 名前・プロフィールのリンク・キャラクターアイコンのカード。全員が編集でき、記録係は追加・招待リンクの発行・名簿から外すことができる
import { api, esc } from "./common.js";

const st = { editing: null, adding: false, link: null };
const ICON_PX = 400; // 保存する大きさ(縦横の長いほう)。画面では最大200pxで出す

function iconHtml(m) {
  const title = m.display_name || m.name;
  return m.icon_at
    ? `<img class="micon" src="/api/members/${m.id}/icon?v=${encodeURIComponent(m.icon_at)}" alt="${esc(title)}さんのアイコン">`
    : `<div class="micon none" aria-hidden="true">${esc([...title][0] || "？")}</div>`;
}

function card(m, me) {
  const title = m.display_name || m.name;
  const tags = `${m.is_owner ? `<span class="tag">管理者</span>` : ""}${m.is_recorder ? `<span class="tag g">記録係</span>` : ""}${m.id === me.memberId ? `<span class="tag gray">自分</span>` : ""}${me.isRecorder && !m.has_account ? `<span class="tag y">未登録</span>` : ""}`;
  if (st.editing === m.id) {
    return `<form class="mcard editing" data-member="${m.id}" onsubmit="return false">
      <div class="miconbox">${iconHtml(m)}
        <div class="row"><label class="btn sub">画像を選ぶ<input type="file" accept="image/*" data-icon="${m.id}" hidden></label>
          ${m.icon_at ? `<button type="button" class="btn sub" data-unicon="${m.id}">外す</button>` : ""}</div>
        <div class="muted small">リベシティと同じ画像を選べます。正方形の画像がきれいに出ます。</div></div>
      <label class="fld"><span>名前（表示名）</span><input name="display_name" value="${esc(m.display_name || "")}" placeholder="例：ニックネーム"></label>
      <label class="fld"><span>呼び名（出欠・タスクの担当に使う短い名前）</span><input name="name" value="${esc(m.name)}"></label>
      <label class="fld"><span>プロフィールのリンク</span><input name="profile_url" value="${esc(m.profile_url || "")}" placeholder="https://"></label>
      ${me.isRecorder ? `<label class="small"><input type="checkbox" name="is_recorder" ${m.is_recorder ? "checked" : ""} ${m.is_owner ? "disabled" : ""}> 記録係にする</label>` : ""}
      <div class="mfoot">
        <button type="button" class="btn" data-save="${m.id}">保存</button>
        <button type="button" class="btn sub" data-cancel="1">キャンセル</button>
        <span class="grow"></span>${me.isRecorder && !m.is_owner ? `<button type="button" class="btn danger" data-remove="${m.id}">名簿から外す</button>` : ""}
      </div></form>`;
  }
  const url = m.profile_url || "";
  return `<div class="mcard" data-member="${m.id}">
    ${iconHtml(m)}
    <div class="mname">${esc(title)}</div>
    <div class="mtags">${tags}</div>
    <div class="mlink">${/^https?:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">プロフィールを見る ↗</a>` : `<span class="muted small">プロフィールのリンクは未記入</span>`}</div>
    <div class="mfoot">
      <button class="btn sub" data-edit="${m.id}">編集</button>
      ${me.isRecorder && m.id !== me.memberId ? `<button class="btn sub" data-invite="${m.id}">${m.has_account ? "🔑 再設定リンク" : "✉️ 招待リンク"}</button>` : ""}
    </div>
    ${st.link?.id === m.id ? `<div class="invitelink"><div class="small">${m.has_account ? "再設定" : "招待"}リンク（${st.link.days}日間・1回だけ使えます）。コピーして本人だけに送ってください。</div>
      <div class="row"><input class="wide" readonly value="${esc(st.link.url)}"><button class="btn" data-copylink="1">コピー</button></div></div>` : ""}
  </div>`;
}

// 選んだ画像を、縦横の長いほうが ICON_PX になるよう小さくする(形は変えない)
async function shrink(file) {
  const img = await createImageBitmap(file).catch(() => { throw new Error("この画像は読み込めませんでした。PNGかJPEGの画像を選んでください。"); });
  const k = Math.min(1, ICON_PX / Math.max(img.width, img.height));
  const cv = Object.assign(document.createElement("canvas"), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  let url = cv.toDataURL("image/webp", 0.9);
  if (!url.startsWith("data:image/webp")) url = cv.toDataURL("image/png"); // WebPで保存できないブラウザ
  const [head, data] = url.split(",");
  return { mime: head.slice(5, head.indexOf(";")), data };
}

export async function mountMembers(box, me) {
  const members = await api("/api/members");
  const add = me.isRecorder ? (st.adding
    ? `<div class="card addmember"><div class="row"><input id="newName" placeholder="呼び名（例：たき）"><input id="newDisplay" class="wide" placeholder="名前（表示名・あとで編集できます）">
        <button class="btn" id="addMember">追加</button><button class="btn sub" id="cancelAdd">やめる</button></div></div>`
    : `<button class="btn" id="openAdd">＋ メンバーを追加</button>`) : "";
  box.innerHTML = `
    <div class="row mbar"><b>${members.length}人</b><span class="grow"></span>${add}</div>
    <div class="mgrid">${members.map((m) => card(m, me)).join("")}</div>
    ${me.isRecorder ? `<p class="muted small">新しい人は「＋ メンバーを追加」→ その人のカードの「✉️ 招待リンク」でリンクを作り、本人だけに送ります。本人がリンクを開いて${me.googleClientId ? "Googleのボタンを押す" : "ログインIDとパスワードを決める"}と使えるようになります。<br>
      ${me.googleClientId ? "Googleアカウントを変えた人" : "パスワードを忘れた人"}には「🔑 再設定リンク」を送ってください。</p>` : ""}`;

  box.onchange = async (e) => {
    const id = e.target.dataset.icon;
    if (!id || !e.target.files[0]) return;
    try {
      const icon = await shrink(e.target.files[0]);
      await api(`/api/members/${id}/icon`, { method: "PUT", body: JSON.stringify(icon) });
      return mountMembers(box, me);
    } catch (err) { alert(err.message); }
  };

  box.onclick = async (e) => {
    const t = e.target, d = t.dataset;
    try {
      if (t.id === "openAdd") { st.adding = true; return mountMembers(box, me); }
      if (t.id === "cancelAdd") { st.adding = false; return mountMembers(box, me); }
      if (t.id === "addMember") {
        const m = await api("/api/members", { method: "POST", body: JSON.stringify({ name: box.querySelector("#newName").value, display_name: box.querySelector("#newDisplay").value }) });
        st.adding = false; st.editing = null;
        await mountMembers(box, me);
        return box.querySelector(`[data-member="${m.id}"]`)?.scrollIntoView({ behavior: "smooth" });
      }
      if (d.edit) { st.editing = Number(d.edit); return mountMembers(box, me); }
      if (d.cancel) { st.editing = null; return mountMembers(box, me); }
      if (d.unicon) {
        await api(`/api/members/${d.unicon}/icon`, { method: "DELETE" });
        return mountMembers(box, me);
      }
      if (d.save) {
        const f = t.closest("form");
        const body = Object.fromEntries(["name", "display_name", "profile_url"].map((k) => [k, f.elements[k].value]));
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
