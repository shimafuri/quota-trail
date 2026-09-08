# quota-trail を「起動元のプロセスツリーに属さない形」で起こす（2026-09-08 追加）
#
# 背景: ターミナル（Claude Code のツールシェル等）から `npm start` / Start-Process で起こすと、
# 起動元のプロセスツリーやジョブオブジェクトの終了に巻き込まれてアプリごと消えることがある
# （2026-09-08 10:45 に「終了」ログを残さず停止した事例）。WMI の Win32_Process.Create で
# 起こすと親は WmiPrvSE.exe になり、起動元が終了しても生き残る。
# Windows 起動時の自動実行（HKCU\...\Run）と同じコマンドラインを使う。
#
# 使い方: powershell -ExecutionPolicy Bypass -File scripts/start-detached.ps1
#
# パッケージ済み exe（dist\win-unpacked\quota-trail.exe）があればそれを優先する（2026-09-08 追加）。
# 開発起動の electron.exe は名前が汎用的なため、他プロジェクトの `Stop-Process electron` に
# 巻き込まれて落ちる（2026-09-08 の事故）。運用は `npm run build:dir` で作った exe を使うこと。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$packaged = Join-Path $root 'dist\win-unpacked\quota-trail.exe'
$devExe = Join-Path $root 'node_modules\electron\dist\electron.exe'

if (Test-Path $packaged) {
  $kind = 'packaged'
  $cmd = "`"$packaged`""
} elseif (Test-Path $devExe) {
  $kind = 'dev (electron.exe)'
  $cmd = "`"$devExe`" `"$root`""
} else {
  throw "起動可能な exe が見つかりません: $packaged も $devExe もありません（npm run build:dir か npm install を先に実行）"
}

$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root }
if ($r.ReturnValue -ne 0) { throw "起動に失敗しました（ReturnValue=$($r.ReturnValue)）" }
Write-Host "quota-trail を起動しました（$kind / PID $($r.ProcessId)）: $cmd"
Write-Host "二重起動なら既存インスタンスがダッシュボードを開いて終了します。"
