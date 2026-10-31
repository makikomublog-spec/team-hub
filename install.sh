#!/bin/bash
# チーム管理ツールの設置(Mac用)。使い方はREADMEを見てください。
# 全体を関数に入れて最後に呼ぶ(ダウンロードが途中で切れたときに、半端に動かないように)
main() {
  set -euo pipefail
  local NODE_VERSION="v22.23.4"
  local SOURCE="${TEAM_HUB_SOURCE:-https://codeload.github.com/makikomublog-spec/team-hub/tar.gz/refs/heads/main}"
  local BASE="$HOME/.team-hub"
  TMP="$(mktemp -d)" # 終了時の片付けで使うので、関数の外からも見える変数にする
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$BASE"

  echo "▶ チーム管理ツールの設置を始めます"

  # Node.js(22以上)。なければ、このツール専用のものを ~/.team-hub に入れる(パソコン全体には入れない)
  local major=0
  if command -v node >/dev/null 2>&1; then major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi
  if [ "$major" -lt 22 ]; then
    local os arch
    case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "✖ このパソコンには対応していません"; return 1 ;; esac
    case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo "✖ このパソコンには対応していません"; return 1 ;; esac
    local name="node-$NODE_VERSION-$os-$arch"
    if [ ! -x "$BASE/$name/bin/node" ]; then
      echo "▶ 必要な部品（Node.js）を準備します"
      curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name.tar.gz" -o "$TMP/node.tar.gz"
      curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/sums.txt"
      local want got
      want="$(grep " $name.tar.gz\$" "$TMP/sums.txt" | cut -d' ' -f1)"
      got="$(shasum -a 256 "$TMP/node.tar.gz" 2>/dev/null | cut -d' ' -f1 || sha256sum "$TMP/node.tar.gz" | cut -d' ' -f1)"
      if [ -z "$want" ] || [ "$want" != "$got" ]; then echo "✖ ダウンロードしたNode.jsを確認できませんでした"; return 1; fi
      tar -xzf "$TMP/node.tar.gz" -C "$BASE"
    fi
    export PATH="$BASE/$name/bin:$PATH"
  fi

  echo "▶ ツールをダウンロードします"
  curl -fsSL "$SOURCE" -o "$TMP/app.tar.gz"
  mkdir "$TMP/app"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" --strip-components=1
  rm -rf "$BASE/app"
  mv "$TMP/app" "$BASE/app"
  cd "$BASE/app"

  echo "▶ 部品を準備します（数分かかることがあります）"
  npm ci --no-audit --no-fund --loglevel=error

  node scripts/install.mjs
}
main "$@"
