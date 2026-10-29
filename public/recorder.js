// 録音して文字起こし(記録係のみ)
// 自分 = マイク、相手 = オンライン会議のタブ(または画面)の音。それぞれ約20秒ごとに区切ってCloudflareのAIで文字起こしする。
// 音声はブラウザの中でだけ扱い、文字起こしが終わったら捨てる(保存しない)。
import { esc } from "./common.js";

const RATE = 16000;            // 文字起こし用のサンプリング周波数
const CHUNK_MAX = 20;          // 1回に送る最大の秒数
const CHUNK_MIN = 14;          // この秒数以降で一番静かなところで区切る
const SILENT = 0.01;           // これより小さい音しかない区間は送らない(無料枠の節約)
export const TRANSCRIPT_KEY = "phub_transcript";

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("tap", Tap);`;

let rec = null;

const hms = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function wav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return buf;
}

// 14〜20秒の間で一番静かな0.25秒を探して、そこで区切る(言葉の途中で切れにくくする)
function cutPoint(buf) {
  const win = RATE / 4;
  let best = buf.length, bestE = Infinity;
  for (let i = CHUNK_MIN * RATE; i + win <= buf.length; i += win / 2) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += buf[j] * buf[j];
    if (e < bestE) { bestE = e; best = i + win / 2; }
  }
  return Math.floor(best);
}

class Track {
  constructor(label, stream, ctx, onLevel) {
    this.label = label; this.stream = stream; this.parts = []; this.len = 0; this.offset = 0; this.queue = Promise.resolve();
    this.src = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, "tap");
    this.node.port.onmessage = (e) => {
      this.parts.push(e.data); this.len += e.data.length;
      let peak = 0; for (const x of e.data) peak = Math.max(peak, Math.abs(x));
      onLevel(label, peak);
    };
    this.src.connect(this.node);
  }
  take() {
    const all = new Float32Array(this.len);
    let o = 0; for (const p of this.parts) { all.set(p, o); o += p.length; }
    return all;
  }
  // 区切れる分を切り出して送る(final=true なら残り全部)
  flush(final, send) {
    if (!final && this.len < CHUNK_MAX * RATE) return;
    const all = this.take();
    const cut = final ? all.length : cutPoint(all);
    const chunk = all.subarray(0, cut), rest = all.slice(cut);
    this.parts = rest.length ? [rest] : []; this.len = rest.length;
    const start = this.offset;
    this.offset += cut / RATE;
    let peak = 0; for (const x of chunk) peak = Math.max(peak, Math.abs(x));
    if (chunk.length < RATE || peak < SILENT) return;
    this.queue = this.queue.then(() => send(this.label, start, wav(chunk)));
  }
  stop() { this.src.disconnect(); this.node.disconnect(); this.stream.getTracks().forEach((t) => t.stop()); }
}

function save() {
  try { localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify({ startedAt: rec.startedAt, lines: rec.lines })); } catch {}
}

function renderLines() {
  const box = document.getElementById("recLines");
  if (!box) return;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = rec.lines.length
    ? rec.lines.map((l) => `<div class="ln ${l.label === "自分" ? "me" : "other"}"><span class="t">${hms(l.t)}</span><b>${l.label}</b> ${esc(l.text)}</div>`).join("")
    : `<p class="muted">話し始めると、20秒ほどでここに文字が出てきます。</p>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function setStatus(html, cls = "") {
  const el = document.getElementById("recStatus");
  if (el) { el.className = "recstatus " + cls; el.innerHTML = html; }
}

async function send(label, start, body) {
  rec.pending++; updateCounters();
  try {
    const res = await fetch("/api/transcribe", { method: "POST", body, headers: { "Content-Type": "audio/wav" } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText);
    for (const s of j.segments) rec.lines.push({ t: start + s.start, label, text: s.text });
    rec.lines.sort((a, b) => a.t - b.t);
    save(); renderLines();
  } catch (err) {
    rec.errors++;
    setStatus(`⚠ ${esc(err.message)}`, "warn");
  } finally {
    rec.pending--; updateCounters();
  }
}

function updateCounters() {
  const el = document.getElementById("recPending");
  if (el) el.textContent = rec?.pending ? `文字起こし中 ${rec.pending}件…` : "";
}

function levelBar(label, peak) {
  const el = document.getElementById(label === "自分" ? "lvMe" : "lvOther");
  if (el) el.style.width = Math.min(100, Math.round(peak * 140)) + "%";
}

export function renderRecorder($app, projectId) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || "null"); } catch { return null; } })();
  const active = rec && rec.state === "recording";
  $app.innerHTML = `
    <p><a href="#/p/${projectId}/minutes">← 議事録一覧</a></p>
    <h1>🎙 録音して文字起こし</h1>
    <div class="card steps">
      <b>準備</b>
      <ol>
        <li>このページは <b>Google Chrome</b> で開いてください。</li>
        <li>オンライン会議（oVice・Zoom・Google Meet など）は <b>Chromeのタブ</b> で開いておくのがおすすめです（アプリ版の場合は「画面全体」を選びます）。</li>
        <li>「録音開始」を押すと、①マイクの許可 → ②共有する画面の選択が出ます。②では <b>会議のタブを選び、「タブの音声も共有する」をオン</b> にしてください。</li>
        <li>録音の前に、参加者に「録音して議事録にします」と伝えてください。</li>
      </ol>
    </div>
    <div class="card recpanel">
      <div class="row">
        <button class="btn rec" id="recStart" ${active ? "disabled" : ""}>● 録音開始</button>
        <button class="btn" id="recStop" ${active ? "" : "disabled"}>■ 停止</button>
        <span id="recTimer" class="timer">00:00:00</span>
        <span id="recPending" class="muted small"></span>
      </div>
      <div class="levels">
        <div><span>自分（マイク）</span><div class="lv"><i id="lvMe"></i></div></div>
        <div><span>相手（会議の音）</span><div class="lv"><i id="lvOther"></i></div></div>
      </div>
      <div id="recStatus" class="recstatus">「録音開始」を押すと始まります。</div>
    </div>
    <div id="recLines" class="reclines"><p class="muted">録音を始めると、ここに文字起こしが表示されます（自分＝青、相手＝緑）。</p></div>
    <div id="recAfter" class="actions" style="display:none">
      <a class="btn" href="#/p/${projectId}/minutes/new" style="text-decoration:none">📝 この文字起こしで議事録を作る</a>
      <button class="btn sub" id="recCopy">📋 文字起こしをコピー</button>
      <button class="btn sub" id="recSave">💾 テキストで保存</button>
      <button class="btn danger" id="recClear">文字起こしを消す</button>
    </div>`;

  if (rec) renderLines();
  else if (saved?.lines?.length) {
    rec = { state: "done", startedAt: saved.startedAt, lines: saved.lines, pending: 0, errors: 0 };
    renderLines();
    setStatus("前回の文字起こしが残っています。議事録を作るか、不要なら消してください。");
  }
  if (rec && rec.state === "done") document.getElementById("recAfter").style.display = "flex";

  $app.onclick = async (e) => {
    const id = e.target.id;
    if (id === "recStart") await start();
    else if (id === "recStop") await stop();
    else if (id === "recCopy") { await navigator.clipboard.writeText(text()); e.target.textContent = "✅ コピーしました"; }
    else if (id === "recSave") download();
    else if (id === "recClear" && confirm("文字起こしを消しますか？（元に戻せません）")) {
      localStorage.removeItem(TRANSCRIPT_KEY); rec = null; renderRecorder($app, projectId);
    }
  };
}

const text = () => rec.lines.map((l) => `[${hms(l.t)}] ${l.label}: ${l.text}`).join("\n");

function download() {
  const d = new Date(rec.startedAt + 9 * 3600_000).toISOString();
  const name = `minutes_${d.slice(0, 10).replaceAll("-", "")}_${d.slice(11, 16).replace(":", "")}_transcript.txt`;
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text()], { type: "text/plain" })), download: name });
  a.click();
}

async function start() {
  if (rec?.lines?.length && rec.state === "done" && !confirm("前回の文字起こしを消して、新しく録音しますか？")) return;
  let mic, screen;
  try {
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return setStatus("⚠ マイクが使えませんでした。ブラウザのマイクの許可を確認してください。", "warn");
  }
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: "include", selfBrowserSurface: "exclude" });
  } catch {
    mic.getTracks().forEach((t) => t.stop());
    return setStatus("⚠ 画面の共有がキャンセルされました。もう一度「録音開始」を押して、会議のタブを選んでください。", "warn");
  }
  if (!screen.getAudioTracks().length) {
    mic.getTracks().forEach((t) => t.stop()); screen.getTracks().forEach((t) => t.stop());
    return setStatus("⚠ 相手の音が取り込めていません。共有するときに「タブの音声も共有する」をオンにしてください。", "warn");
  }
  const ctx = new AudioContext({ sampleRate: RATE });
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
  rec = { state: "recording", startedAt: Date.now(), lines: [], pending: 0, errors: 0, ctx,
    tracks: [new Track("自分", mic, ctx, levelBar), new Track("相手", new MediaStream(screen.getAudioTracks()), ctx, levelBar)], screen };
  localStorage.removeItem(TRANSCRIPT_KEY);
  screen.getVideoTracks()[0]?.addEventListener("ended", () => rec?.state === "recording" && stop()); // 共有を止めたら録音も止める
  rec.timer = setInterval(() => {
    const el = document.getElementById("recTimer");
    if (el) el.textContent = hms((Date.now() - rec.startedAt) / 1000);
    rec.tracks.forEach((t) => t.flush(false, send));
  }, 1000);
  window.onbeforeunload = () => "録音中です。ページを離れると録音が止まります。";
  renderLines();
  setStatus(`<span class="dot"></span>録音中です。このタブは開いたままにしてください（別のタブを見るのは大丈夫です）。`);
  document.getElementById("recStart").disabled = true;
  document.getElementById("recStop").disabled = false;
}

async function stop() {
  if (!rec || rec.state !== "recording") return;
  rec.state = "finishing";
  clearInterval(rec.timer);
  rec.tracks.forEach((t) => t.flush(true, send));
  rec.tracks.forEach((t) => t.stop());
  rec.screen.getTracks().forEach((t) => t.stop());
  document.getElementById("recStop").disabled = true;
  setStatus("録音を止めました。残りを文字起こししています…");
  await Promise.all(rec.tracks.map((t) => t.queue));
  await rec.ctx.close();
  rec.state = "done";
  window.onbeforeunload = null;
  save();
  setStatus(`✅ 文字起こしが完了しました（${rec.lines.length}行）。${rec.errors ? `　⚠ ${rec.errors}回、文字起こしに失敗した区間があります。` : ""}`, "done");
  const after = document.getElementById("recAfter");
  if (after) after.style.display = "flex";
  document.getElementById("recStart").disabled = false;
}
