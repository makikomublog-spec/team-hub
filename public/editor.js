// 議事録の作成(記録係のみ)
// 1. 会議情報を入れてプロンプトをコピー → 2. AI（Claude・ChatGPTなど）の返答を貼って読み込み → 3. 確認・修正して公開
import { api, esc, STATUS_ATT, recordersText } from "./common.js";
import { TRANSCRIPT_KEY } from "./recorder.js";

let ed = null; // { projectId, id, payload, members, project, openTasks }

const listText = (v) => (Array.isArray(v) ? v : String(v || "").split("\n")).map((x) => String(x).trim()).filter(Boolean).join("\n");
// 名前の照合用: 空白・【推定】・「さん」を除き、ひらがなをカタカナに、英字を小文字にそろえる
const norm = (s) => String(s || "").replace(/[\s　【】]|推定|さん$|さん(?=[\s　【])/g, "")
  .replace(/[\u3041-\u3096]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)).toLowerCase();

function findMember(name) {
  const n = norm(name);
  if (!n) return null;
  return ed.members.find((m) => norm(m.name) === n) || ed.members.find((m) => n.includes(norm(m.name)) || norm(m.name).includes(n)) || null;
}

function buildPrompt(info) {
  const names = ed.members.map((m) => m.name).join("、");
  const open = ed.openTasks.map((t) => `- ${t.assignee || "担当未定"}：${t.title}${t.due_date ? `（期限 ${t.due_date}）` : ""}`).join("\n") || "- なし";
  return `あなたは会議の書記です。下の「文字起こし」から議事録を作り、指定の形式のJSONだけを出力してください。

# 会議情報
プロジェクト：${ed.project.name}
会議名：${info.title}
日時：${info.date} ${info.time}

# メンバー名簿（人の名前は必ずこの表記を使う）
${names}

# 現在の未完了タスク（参考。会議で進み具合や完了が話されたら progress_note に書く）
${open}

# ルール
- 文字起こしには聞き間違いがあります。名簿と文脈から正しい名前・言葉に直してください。
- 名乗っていない発言者を内容から推測した場合は、末尾に【推定】を付けてください。
- 分からないことは空にしてください。話に出ていないことを作らないでください。
- 雑談、体調や家庭などの個人的な話題は入れないでください。
- 日付は YYYY-MM-DD 形式。期限が話されていないタスクは空文字にしてください。
- 出力は \`\`\`json で囲んだJSONだけにしてください（説明文は不要）。

# 出力形式
\`\`\`json
{
  "summary": ["要旨（3項目以内）"],
  "agenda": ["今回の議題"],
  "attendance": [{"name": "名簿の名前", "status": "present（発言あり）/ listen（聞き専）/ absent（欠席）", "note": ""}],
  "decisions": ["決定事項"],
  "confirmations": ["確認事項（会議で確認できた事実）"],
  "tasks": [{"title": "やること", "assignee": "名簿の名前（不明なら空）", "start_date": "", "due_date": ""}],
  "issues": ["未解決事項"],
  "next_actions": ["次回までにやること"],
  "progress_note": "プロジェクト全体の進捗（2〜3文）",
  "next_checks": ["次回会議で確認すること"],
  "qas": [{"question": "質問", "answer": "回答（出ていなければ空）", "asked_by": "質問した人（名簿の名前、不明なら空）"}],
  "discussion": "## 見出し\\n- 要点\\n- 要点\\n## 見出し\\n- 要点",
  "next_meeting": {"date": "次回の日付（不明なら空）", "time": "HH:MM（不明なら空）"}
}
\`\`\`

# 文字起こし
${ed.transcript ? ed.transcript : "（↓ここに文字起こしを貼り付けてください）\n"}`;
}

// 録音画面で作った文字起こし(このブラウザに一時保存されている)
function loadTranscript() {
  try {
    const t = JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || "null");
    if (!t?.lines?.length) return null;
    const hms = (sec) => new Date(Math.floor(sec) * 1000).toISOString().slice(11, 19);
    return { startedAt: t.startedAt, count: t.lines.length, text: t.lines.map((l) => `[${hms(l.t)}] ${l.label}: ${l.text}`).join("\n") };
  } catch { return null; }
}

function parseAiJson(text) {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let raw = block ? block[1] : text;
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("JSONが見つかりません。AIの返答を、```json から最後の ``` まで丸ごと貼ってください。");
  try {
    return JSON.parse(raw.slice(a, b + 1));
  } catch {
    throw new Error("JSONの形が崩れています。AIに「JSONだけを出力し直してください」と頼んで、もう一度貼ってください。");
  }
}

// AIの返答 → 確認画面で使う形に変換(名前を名簿のIDに結びつける)
function fromAi(j, info) {
  const att = {};
  for (const a of j.attendance || []) {
    const m = findMember(a.name);
    if (m && ["present", "listen", "absent"].includes(a.status)) att[m.id] = { status: a.status, note: /推定/.test(a.name + a.note) ? "推定" : a.note || "" };
  }
  return {
    ...info,
    summary: listText(j.summary), agenda: listText(j.agenda), decisions: listText(j.decisions),
    confirmations: listText(j.confirmations), issues: listText(j.issues), next_actions: listText(j.next_actions),
    progress_note: String(j.progress_note || ""), next_checks: listText(j.next_checks), discussion: String(j.discussion || ""),
    attendance: ed.members.map((m) => ({ member_id: m.id, status: att[m.id]?.status || "absent", note: att[m.id]?.note || (att[m.id] ? "" : "要確認") })),
    tasks: (j.tasks || []).map((t) => {
      const m = findMember(t.assignee);
      return { register: true, title: String(t.title || ""), assignee_id: m?.id || "", assignee_raw: m ? "" : String(t.assignee || ""), start_date: t.start_date || "", due_date: t.due_date || "" };
    }),
    qas: (j.qas || []).map((q) => ({ question: String(q.question || ""), answer: String(q.answer || ""), asked_by: findMember(q.asked_by)?.name || String(q.asked_by || "") })),
    next_meeting: { date: j.next_meeting?.date || "", time: j.next_meeting?.time || "" },
  };
}

const field = (label, name, value, rows = 3, hint = "") =>
  `<label class="fld"><span>${label}${hint ? `<small>${hint}</small>` : ""}</span><textarea name="${name}" rows="${rows}">${esc(value)}</textarea></label>`;

function infoForm(p) {
  const [date, time] = (p.held_at || "").split(" ");
  return `
    <div class="row">
      <label class="fld grow"><span>会議名</span><input name="title" value="${esc(p.title)}" placeholder="例：第2回 運営ミーティング"></label>
      <label class="fld"><span>日付</span><input type="date" name="date" value="${esc(date || "")}"></label>
      <label class="fld"><span>開始</span><input type="time" name="time" value="${esc(time || "20:00")}"></label>
      <label class="fld"><span>終了</span><input type="time" name="ended_at" value="${esc(p.ended_at || "")}"></label>
      <label class="fld"><span>場所</span><input name="place" value="${esc(p.place ?? "")}"></label>
      <label class="fld"><span>進行</span><input name="facilitator" value="${esc(p.facilitator ?? "")}"></label>
    </div>`;
}

function reviewForm(p) {
  const memberOpts = (sel) => `<option value="">担当未定</option>` + ed.members.map((m) => `<option value="${m.id}" ${String(m.id) === String(sel) ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  const attRows = p.attendance.map((a) => {
    const m = ed.members.find((x) => x.id === a.member_id);
    return `<tr data-att="${a.member_id}"><td>${esc(m?.name)}</td>
      <td><select name="att_status">${Object.entries(STATUS_ATT).map(([k, v]) => `<option value="${k}" ${k === a.status ? "selected" : ""}>${v}</option>`).join("")}</select></td>
      <td><input name="att_note" value="${esc(a.note)}" class="wide"></td></tr>`;
  }).join("");
  const taskRows = p.tasks.map((t, i) => `<tr data-task-i="${i}">
      <td><input type="checkbox" name="t_register" ${t.register ? "checked" : ""}></td>
      <td><textarea name="t_title" rows="1" class="title">${esc(t.title)}</textarea></td>
      <td><select name="t_assignee">${memberOpts(t.assignee_id)}</select>${t.assignee_raw ? `<div class="late">AIの記載「${esc(t.assignee_raw)}」は名簿にいません</div>` : ""}</td>
      <td><input type="date" name="t_start" value="${esc(t.start_date)}"></td>
      <td><input type="date" name="t_due" value="${esc(t.due_date)}"></td></tr>`).join("");
  const qaRows = p.qas.map((q, i) => `<div class="qa-edit" data-qa-i="${i}">
      <input name="q_question" value="${esc(q.question)}" placeholder="質問" class="wide">
      <textarea name="q_answer" rows="2" placeholder="回答（空なら未回答）">${esc(q.answer)}</textarea>
      <div class="row"><input name="q_asked_by" value="${esc(q.asked_by)}" placeholder="質問した人"><button type="button" class="btn sub" data-qa-del="${i}">この質問を外す</button></div></div>`).join("");
  return `
    <h2>3. 確認・修正</h2>
    <p class="muted">AIの下書きです。1行に1項目で書いてください。直し終わったら一番下の「公開する」を押します。</p>
    ${field("要旨", "summary", p.summary, 3)}
    ${field("■ 今回の議題", "agenda", p.agenda, 3)}
    ${field("■ 決定事項", "decisions", p.decisions, 4)}
    ${field("■ 確認事項", "confirmations", p.confirmations, 3)}
    ${ed.fix ? `<div class="fld"><span>■ 担当タスク</span><p class="notice small">この会議で決まったタスクは、<a href="#/p/${ed.projectId}/tasks">タスク画面</a>で修正してください（議事録の表にも反映されます）。</p></div>` : `
    <div class="fld"><span>■ 担当タスク <small>チェックを外したものは登録しません。担当者は名簿から選びます</small></span>
      <table class="tasks"><tr><th style="width:50px">登録</th><th>内容</th><th style="width:160px">担当</th><th style="width:150px">開始日</th><th style="width:150px">期限</th></tr>
      ${taskRows || `<tr><td colspan="5" class="muted">タスクはありません</td></tr>`}</table>
      <button type="button" class="btn sub" id="addTaskRow">＋ タスクを追加</button></div>`}
    ${field("■ 未解決事項", "issues", p.issues, 3)}
    ${field("■ 次回までにやること", "next_actions", p.next_actions, 3)}
    ${field("■ プロジェクト進捗", "progress_note", p.progress_note, 3)}
    ${field("■ 次回会議で確認すること", "next_checks", p.next_checks, 3)}
    ${ed.fix ? "" : `<div class="row">
      <label class="fld"><span>次回会議の日付 <small>カレンダーに載ります</small></span><input type="date" name="nm_date" value="${esc(p.next_meeting?.date || "")}"></label>
      <label class="fld"><span>時刻</span><input type="time" name="nm_time" value="${esc(p.next_meeting?.time || "")}"></label>
    </div>`}
    <div class="fld"><span>出欠 <small>AIが判断できなかった人は「欠席・要確認」になっています</small></span>
      <table><tr><th style="width:160px">名前</th><th style="width:170px">出欠</th><th>備考</th></tr>${attRows}</table></div>
    <div class="fld"><span>質疑応答</span>${qaRows || `<p class="muted">なし</p>`}</div>
    ${p.keep_body ? `<p class="notice small">この議事録には、図などを含む詳しい本文があります。「議論の内容」を空のままにすると、その本文はそのまま残ります（書き込むと置き換わります）。</p>` : ""}
    ${field("議論の内容", "discussion", p.discussion, 10, "「## 見出し」「- 要点」の形で書くと、見出しと箇条書きになります")}`;
}

function collect() {
  const f = document.getElementById("edForm");
  const v = (n) => f.elements[n]?.value ?? "";
  const p = { ...ed.payload };
  Object.assign(p, {
    title: v("title").trim(), held_at: v("date") ? `${v("date")} ${v("time") || "00:00"}` : "", ended_at: v("ended_at"),
    place: v("place"), facilitator: v("facilitator"),
  });
  if (!p.reviewing) return p;
  for (const k of ["summary", "agenda", "decisions", "confirmations", "issues", "next_actions", "progress_note", "next_checks", "discussion"]) p[k] = v(k);
  if (!ed.fix) p.next_meeting = { date: v("nm_date"), time: v("nm_time") };
  p.attendance = [...f.querySelectorAll("tr[data-att]")].map((tr) => ({
    member_id: Number(tr.dataset.att), status: tr.querySelector('[name="att_status"]').value, note: tr.querySelector('[name="att_note"]').value,
  }));
  if (!ed.fix) p.tasks = [...f.querySelectorAll("tr[data-task-i]")].map((tr) => ({
    register: tr.querySelector('[name="t_register"]').checked, title: tr.querySelector('[name="t_title"]').value,
    assignee_id: tr.querySelector('[name="t_assignee"]').value, start_date: tr.querySelector('[name="t_start"]').value, due_date: tr.querySelector('[name="t_due"]').value,
  }));
  p.qas = [...f.querySelectorAll("[data-qa-i]")].map((d) => ({
    question: d.querySelector('[name="q_question"]').value, answer: d.querySelector('[name="q_answer"]').value, asked_by: d.querySelector('[name="q_asked_by"]').value,
  }));
  return p;
}

function drawFix($app) {
  const p = ed.payload;
  $app.innerHTML = `
    <p><a href="#/p/${ed.projectId}/minutes/${ed.id}">← 議事録に戻る</a></p>
    <h1>議事録を修正<span class="tag g">公開済み</span></h1>
    <form id="edForm" class="editor" onsubmit="return false">
      <h2>会議の情報</h2>
      ${infoForm(p)}
      ${reviewForm(p).replace("<h2>3. 確認・修正</h2>", "").replace("AIの下書きです。1行に1項目で書いてください。直し終わったら一番下の「公開する」を押します。", "1行に1項目で書いてください。直し終わったら一番下の「修正を保存」を押します。")}
      <div class="actions">
        <button type="button" class="btn" id="saveFix">修正を保存</button>
        <a href="#/p/${ed.projectId}/minutes/${ed.id}">キャンセル</a>
      </div>
    </form>`;
}

function draw($app) {
  if (ed.fix) return drawFix($app);
  const p = ed.payload;
  $app.innerHTML = `
    <p><a href="#/p/${ed.projectId}/minutes">← 議事録一覧</a></p>
    <h1>議事録を作る${ed.id ? `<span class="tag">下書き</span>` : ""}</h1>
    <form id="edForm" class="editor" onsubmit="return false">
      <h2>1. 会議の情報</h2>
      ${infoForm(p)}
      <div class="card steps">
        <b>プロンプトの使い方</b>
        <ol>
          <li>「プロンプトをコピー」を押す</li>
          <li>Claude か ChatGPTの新しいチャットに貼り付ける</li>
          <li>その下に、会議の文字起こしを貼り付けて送信する</li>
          <li>返ってきた答えを丸ごとコピーして、下の「2.」に貼る</li>
        </ol>
        ${ed.transcript ? `<p class="notice small">🎙 録音の文字起こし（${ed.transcriptCount}行）を読み込みました。プロンプトに自動で含まれるので、<b>コピーして貼るだけ</b>で大丈夫です（手順3は不要）。</p>` : ""}
        <button type="button" class="btn" id="copyPrompt">📋 プロンプト${ed.transcript ? "（文字起こし入り）" : ""}をコピー</button> <span id="copied" class="saved"></span>
      </div>
      <h2>2. AIの返答を貼る</h2>
      <textarea id="aiText" rows="6" class="wide" placeholder="AIの返答（\`\`\`json から始まる部分）をここに貼り付け"></textarea>
      <p><button type="button" class="btn" id="loadAi">読み込む</button>
        ${p.reviewing ? `<span class="muted small">　読み込むと、下の確認画面の内容は置き換わります</span>` : ""}</p>
      ${p.reviewing ? reviewForm(p) : ""}
      <div class="actions">
        <button type="button" class="btn sub" id="saveDraft">下書き保存</button>
        ${p.reviewing ? `<button type="button" class="btn" id="publish">公開する</button>` : ""}
        ${ed.id ? `<button type="button" class="btn danger" id="delDraft">下書きを削除</button>` : ""}
        <span id="saved" class="saved"></span>
      </div>
    </form>`;
}

async function save(silent) {
  ed.payload = collect();
  const r = await api(`/api/projects/${ed.projectId}/meetings/draft`, { method: "POST", body: JSON.stringify({ id: ed.id, payload: ed.payload }) });
  if (!ed.id) { ed.id = r.id; history.replaceState(null, "", `#/p/${ed.projectId}/minutes/edit/${r.id}`); }
  if (!silent) { const el = document.getElementById("saved"); if (el) el.textContent = "✓ 下書きを保存しました"; }
}

function fromPublished(d, members) {
  const m = d.meeting;
  const st = Object.fromEntries(d.attendance.filter((a) => a.status).map((a) => [a.member_id, a]));
  return {
    reviewing: true, title: m.title, held_at: m.held_at, ended_at: m.ended_at ? m.ended_at.slice(11, 16) : "",
    place: m.place, facilitator: m.facilitator, summary: m.summary, agenda: m.agenda,
    decisions: d.decisions.map((x) => x.content).join("\n"), confirmations: m.confirmations,
    issues: d.issues.map((x) => x.content).join("\n"), next_actions: m.next_actions, progress_note: m.progress_note,
    next_checks: m.next_checks, discussion: m.discussion || "", keep_body: !m.discussion && !!m.body_html,
    attendance: members.map((x) => ({ member_id: x.id, status: st[x.id]?.status || "absent", note: st[x.id]?.note || "" })),
    qas: d.qas.map((q) => ({ question: q.question, answer: q.answer, asked_by: q.asked_by })), tasks: [],
  };
}

export async function renderMinutesEditor($app, projectId, meetingId, me, fix = false) {
  if (!me.isRecorder) { $app.innerHTML = `<div class="notice">議事録の作成は記録係（${esc(recordersText())}）のみです。</div>`; return; }
  const [members, project, tasks, existing] = await Promise.all([
    api("/api/members"), api(`/api/projects/${projectId}`), api(`/api/projects/${projectId}/tasks`),
    meetingId ? api(`/api/meetings/${meetingId}`) : null,
  ]);
  if (fix) {
    if (!existing || existing.meeting.status !== "published") { location.hash = `#/p/${projectId}/minutes`; return; }
    ed = { projectId, id: meetingId, fix: true, members, project: project.project, openTasks: [], payload: fromPublished(existing, members) };
    draw($app);
    $app.onclick = async (e) => {
      if (e.target.dataset.qaDel) { ed.payload = collect(); ed.payload.qas.splice(Number(e.target.dataset.qaDel), 1); return draw($app); }
      if (e.target.id !== "saveFix") return;
      try {
        const p = collect();
        await api(`/api/meetings/${meetingId}/update`, { method: "POST", body: JSON.stringify({ payload: p }) });
        location.hash = `#/p/${projectId}/minutes/${meetingId}`;
      } catch (err) { alert(err.message); }
    };
    return;
  }
  if (existing && existing.meeting.status !== "draft") { location.hash = `#/p/${projectId}/minutes/${meetingId}`; return; }
  const payload = existing?.meeting.draft_json ? JSON.parse(existing.meeting.draft_json) : { title: "", held_at: "", place: "" };
  ed = { projectId, id: meetingId || null, payload, members, project: project.project, openTasks: tasks.filter((t) => t.status !== "done") };
  const tr = loadTranscript();
  if (tr) {
    ed.transcript = tr.text; ed.transcriptCount = tr.count;
    if (!payload.held_at) { // 録音を始めた日時を会議の日時の初期値にする
      const d = new Date(tr.startedAt + 9 * 3600_000).toISOString();
      payload.held_at = `${d.slice(0, 10)} ${d.slice(11, 16)}`;
    }
  }
  draw($app);

  $app.onclick = async (e) => {
    const id = e.target.id;
    try {
      if (id === "copyPrompt") {
        const p = collect();
        if (!p.title || !p.held_at) return alert("会議名と日付を入れてください");
        const text = buildPrompt({ title: p.title, date: p.held_at.slice(0, 10), time: p.held_at.slice(11) });
        try {
          await navigator.clipboard.writeText(text);
          document.getElementById("copied").textContent = "✓ コピーしました";
        } catch {
          // コピーできない環境では、プロンプトを表示して手でコピーしてもらう
          const box = document.getElementById("copied");
          box.innerHTML = `<br>自動でコピーできませんでした。下の文章を全部選択してコピーしてください。<textarea rows="8" class="wide" readonly>${esc(text)}</textarea>`;
          box.querySelector("textarea").select();
        }
      } else if (id === "loadAi") {
        const p = collect();
        const j = parseAiJson(document.getElementById("aiText").value);
        ed.payload = { ...fromAi(j, { title: p.title, held_at: p.held_at, ended_at: p.ended_at, place: p.place, facilitator: p.facilitator }), reviewing: true };
        draw($app);
        await save(true);
        document.querySelector("h2:nth-of-type(3)")?.scrollIntoView({ behavior: "smooth" });
      } else if (id === "addTaskRow") {
        ed.payload = collect();
        ed.payload.tasks.push({ register: true, title: "", assignee_id: "", start_date: "", due_date: "" });
        draw($app);
      } else if (e.target.dataset.qaDel) {
        ed.payload = collect();
        ed.payload.qas.splice(Number(e.target.dataset.qaDel), 1);
        draw($app);
      } else if (id === "saveDraft") {
        await save(false);
      } else if (id === "publish") {
        await save(true);
        const p = ed.payload;
        const n = p.tasks.filter((t) => t.register && t.title.trim()).length;
        if (!confirm(`「${p.title}」を公開しますか？\n決定事項・タスク${n}件・Q&A・課題がプロジェクトに反映され、全員が見られるようになります。`)) return;
        await api(`/api/meetings/${ed.id}/publish`, { method: "POST", body: JSON.stringify({ payload: p }) });
        localStorage.removeItem(TRANSCRIPT_KEY);
        location.hash = `#/p/${projectId}/minutes/${ed.id}`;
      } else if (id === "delDraft") {
        if (!confirm("この下書きを削除しますか？")) return;
        await api(`/api/meetings/${ed.id}`, { method: "DELETE" });
        location.hash = `#/p/${projectId}/minutes`;
      }
    } catch (err) {
      alert(err.message);
    }
  };
}
