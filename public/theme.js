// 画面の色(7色)。選んだ色はこのブラウザに覚えておく(人ごと・パソコンやスマホごと)
const THEMES = [
  ["green", "緑", "#2e7d6b"], ["blue", "青", "#1f63b0"], ["indigo", "藍", "#3a4a8c"], ["purple", "紫", "#6a4c9c"],
  ["pink", "桃", "#a8457f"], ["teal", "水", "#0e6f86"], ["gray", "墨", "#4a5560"],
];
const KEY = "team-hub-theme";

function current() {
  try { return localStorage.getItem(KEY) || "green"; } catch { return "green"; }
}

function apply(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem(KEY, name); } catch { /* 覚えられなくても、今の画面には反映する */ }
}

const box = document.getElementById("themepick");
if (box) {
  box.innerHTML = `<summary title="画面の色を変える">🎨 色</summary>
    <div class="themebox" role="group" aria-label="画面の色"><div class="ttl">画面の色</div>
      ${THEMES.map(([k, label, c]) => `<button type="button" class="swatch" data-theme-name="${k}" aria-pressed="${k === current()}"><i style="background:${c}"></i>${label}</button>`).join("")}</div>`;
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-name]");
    if (!b) return;
    apply(b.dataset.themeName);
    box.querySelectorAll("[data-theme-name]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  });
  // 外を押したら閉じる
  document.addEventListener("click", (e) => { if (!box.contains(e.target)) box.open = false; });
}
