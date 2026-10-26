# Custom Hermes supervisor: keeps autoselector (8788), Hermes dashboard (9120) and Hermes gateway (cron) alive.
param(
  [string]$Root = $PSScriptRoot,
  [string]$Hermes = $env:CUSTOM_HERMES_HERMES,
  [string]$Python = $env:CUSTOM_HERMES_PYTHON,
  [int]$AutoPort = 8788,
  [int]$DashPort = 9120
)
$ErrorActionPreference = 'Continue'
$m = New-Object System.Threading.Mutex($false, 'Global\Custom-HermesSupervisor'); if (-not $m.WaitOne(0)) { exit 0 }
if (-not $Hermes) { $c = Get-Command hermes -EA 0; $Hermes = if ($c) { $c.Source } else { "$env:LOCALAPPDATA\hermes\bin\hermes.exe" } }
if (-not $Python) { $c = Get-Command pythonw -EA 0; $Python = if ($c) { $c.Source } else { (Get-Command python).Source } }
$env:HERMES_HOME = "$Root\hermes-home"; $env:PORT = "$AutoPort"
New-Item -ItemType Directory -Force "$Root\logs" | Out-Null
$svc = [ordered]@{
  autoselector = @{ f = $Python; a = "`"$Root\autoselector\autoselector.py`""; d = "$Root\autoselector"; port = $AutoPort }
  dashboard    = @{ f = $Hermes; a = "dashboard --port $DashPort --host 127.0.0.1 --skip-build --no-open"; d = $Root; port = $DashPort }
  gateway      = @{ f = $Hermes; a = 'gateway'; d = $Root; port = 0 }
}
$p = @{}
function L($x) { "$(Get-Date -f s) $x" | Add-Content "$Root\logs\supervisor.log" }
function Up($port) { [bool](Get-NetTCPConnection -State Listen -LocalPort $port -EA 0) }
function Kill($k) { if ($p[$k] -and -not $p[$k].HasExited) { taskkill /T /F /PID $p[$k].Id | Out-Null }; $p[$k] = $null }
function Start1($k) { $x = $svc[$k]; $p[$k] = Start-Process -FilePath $x.f -ArgumentList $x.a -WorkingDirectory $x.d -WindowStyle Hidden -PassThru -RedirectStandardOutput "$Root\logs\$k.out.log" -RedirectStandardError "$Root\logs\$k.err.log"; L "$k started pid $($p[$k].Id)" }
function CronOk() { $o = & $Hermes cron status 2>&1 | Out-String; $o -match 'Gateway is running' }
L "supervisor start user=$env:USERNAME hermes=$Hermes python=$Python"
$last = Get-Date; $lastCron = Get-Date
while ($true) {
  $now = Get-Date; $wake = ($now - $last).TotalSeconds -gt 90; if ($wake) { L "wake/resume detected, full verify" }; $last = $now
  foreach ($k in $svc.Keys) {
    $x = $svc[$k]; $dead = -not $p[$k] -or $p[$k].HasExited
    if ($x.port -and $dead -and (Up $x.port)) { continue }
    if ($dead) { if ($p[$k]) { L "$k exited, restarting" }; Start1 $k; continue }
    if ($x.port -and $wake) { Start-Sleep 5; if (-not (Up $x.port)) { L "$k port down after wake, restarting"; Kill $k; Start1 $k } }
  }
  if ($wake -or ($now - $lastCron).TotalMinutes -ge 5) { $lastCron = $now; if (-not (CronOk)) { L 'cron scheduler not running, restarting gateway'; Kill 'gateway'; Start1 'gateway' } }
  Start-Sleep 15
}
