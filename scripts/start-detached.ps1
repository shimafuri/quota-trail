# quota-trail を「起動元のプロセスツリーに属さない形」で起こす（2026-09-08 追加）
#
# 背景: ターミナル（Claude Code のツールシェル等）から `npm start` / Start-Process で起こすと、
# 起動元のプロセスツリーやジョブオブジェクトの終了に巻き込まれてアプリごと消えることがある
# （2026-09-08 10:45 に「終了」ログを残さず停止した事例）。WMI の Win32_Process.Create で
# 起こすと親は WmiPrvSE.exe になり、起動元が終了しても生き残る。
# Windows 起動時の自動実行（HKCU\...\Run）と同じコマンドラインを使う。
#
# 使い方: powershell -ExecutionPolicy Bypass -File scripts/start-detached.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "electron.exe が見つかりません: $exe（npm install を先に実行）" }

$cmd = "`"$exe`" `"$root`""
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root }
if ($r.ReturnValue -ne 0) { throw "起動に失敗しました（ReturnValue=$($r.ReturnValue)）" }
Write-Host "quota-trail を起動しました（PID $($r.ProcessId)）。二重起動なら既存インスタンスがダッシュボードを開いて終了します。"
