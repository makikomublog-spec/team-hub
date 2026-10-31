# チーム管理ツールの設置(Windows用)。使い方はREADMEを見てください。
# 関数に入れて最後に呼ぶ(ダウンロードが途中で切れたときに、半端に動かないように)
function Install-TeamHub {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $NodeVersion = "v22.23.4"
  $Source = if ($env:TEAM_HUB_SOURCE) { $env:TEAM_HUB_SOURCE } else { "https://codeload.github.com/makikomublog-spec/team-hub/zip/refs/heads/main" }
  $Base = Join-Path $HOME ".team-hub"
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("team-hub-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $Base, $Tmp | Out-Null

  try {
    Write-Host "> チーム管理ツールの設置を始めます"

    # Node.js(22以上)。なければ、このツール専用のものを ~\.team-hub に入れる(パソコン全体には入れない)
    $major = 0
    if (Get-Command node -ErrorAction SilentlyContinue) { $major = [int](node -p "process.versions.node.split('.')[0]") }
    if ($major -lt 22) {
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
      $name = "node-$NodeVersion-win-$arch"
      if (-not (Test-Path (Join-Path $Base "$name\node.exe"))) {
        Write-Host "> 必要な部品（Node.js）を準備します"
        $zip = Join-Path $Tmp "node.zip"
        Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/$name.zip" -OutFile $zip -UseBasicParsing
        $sums = (Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
        if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
        $line = ($sums -split "`n") | Where-Object { $_ -match " $name\.zip$" }
        $want = if ($line) { ($line -split "\s+")[0] } else { "" }
        if (-not $want -or $want -ne (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()) { throw "ダウンロードしたNode.jsを確認できませんでした" }
        Expand-Archive $zip -DestinationPath $Base -Force
      }
      $env:Path = (Join-Path $Base $name) + ";" + $env:Path
    }

    Write-Host "> ツールをダウンロードします"
    $appZip = Join-Path $Tmp "app.zip"
    Invoke-WebRequest $Source -OutFile $appZip -UseBasicParsing
    $extract = Join-Path $Tmp "app"
    Expand-Archive $appZip -DestinationPath $extract
    $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
    $app = Join-Path $Base "app"
    if (Test-Path $app) { Remove-Item $app -Recurse -Force }
    Move-Item $inner.FullName $app
    Set-Location $app

    Write-Host "> 部品を準備します（数分かかることがあります）"
    & npm.cmd ci --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "部品の準備に失敗しました" }

    & node scripts\install.mjs
  } catch {
    Write-Host "`nX $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "この画面のスクショを、ツールを教えてくれた人に見せてください。"
  } finally {
    Set-Location $HOME
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Install-TeamHub
