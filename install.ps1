<#
Custom Hermes installer (idempotent). Run from the repo root in PowerShell:
  powershell -ExecutionPolicy Bypass -File .\install.ps1 [-InstallDir <path>] [-SkipApp] [-SkipHermesInstall] [-AtStartup] [-DryRun]
#>
param(
  [string]$InstallDir = "$env:USERPROFILE\Custom-Hermes",
  [switch]$SkipApp,
  [switch]$SkipHermesInstall,
  [switch]$AtStartup,   # also add a boot trigger (requires an elevated shell)
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Src = $PSScriptRoot
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Do-It([string]$desc, [scriptblock]$sb) { if ($DryRun) { Write-Host "[dry-run] $desc" } else { & $sb } }

Step 'Prerequisites'
$py = Get-Command python -EA 0
if (-not $py) { Do-It 'winget install Python.Python.3.12' { winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements } }
else { Write-Host "python: $(& python --version 2>&1)" }
if (-not $SkipApp) {
  if (-not (Get-Command node -EA 0)) { Do-It 'winget install OpenJS.NodeJS.LTS' { winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements } }
  else { Write-Host "node: $(& node --version)" }
}

Step 'Hermes Agent'
$hermes = (Get-Command hermes -EA 0).Source
if (-not $hermes -and (Test-Path "$env:LOCALAPPDATA\hermes\bin\hermes.exe")) { $hermes = "$env:LOCALAPPDATA\hermes\bin\hermes.exe" }
if (-not $hermes -and -not $SkipHermesInstall) {
  Do-It 'install Hermes Agent (official Nous Research installer)' { Invoke-Expression (Invoke-RestMethod 'https://hermes-agent.nousresearch.com/install.ps1') }
  $hermes = (Get-Command hermes -EA 0).Source
  if (-not $hermes) { $hermes = "$env:LOCALAPPDATA\hermes\bin\hermes.exe" }
}
Write-Host "hermes: $hermes"

Step "Copy files to $InstallDir"
Do-It "create $InstallDir" {
  foreach ($d in 'autoselector','hermes-home','logs','icons','app') { New-Item -ItemType Directory -Force (Join-Path $InstallDir $d) | Out-Null }
  Copy-Item "$Src\autoselector\autoselector.py","$Src\autoselector\nous_keys.example.txt" "$InstallDir\autoselector" -Force
  Copy-Item "$Src\supervisor.ps1" $InstallDir -Force
  Copy-Item "$Src\app\build\*" "$InstallDir\icons" -Force
  Copy-Item "$Src\app\*" "$InstallDir\app" -Recurse -Force
  $cfg = "$InstallDir\hermes-home\config.yaml"
  if (-not (Test-Path $cfg)) { Copy-Item "$Src\config\config.yaml.template" $cfg }  # never overwrite an existing config
}

Step 'API keys'
$kf = "$InstallDir\autoselector\nous_keys.txt"
if (-not (Test-Path $kf) -and -not $env:NOUS_API_KEY) {
  Write-Warning "No keys yet. Put one Nous Portal key per line in $kf (see nous_keys.example.txt) or set NOUS_API_KEY. Without keys the autoselector falls back to Pollinations (slow, keyless)."
}

Step 'Scheduled task CustomHermes'
$pwsh = (Get-Command powershell).Source
$arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\supervisor.ps1`" -Root `"$InstallDir`" -Hermes `"$hermes`""
Do-It 'register task (AtLogOn, restart on failure)' {
  $a = New-ScheduledTaskAction -Execute $pwsh -Argument $arg -WorkingDirectory $InstallDir
  $t = @(New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
  if ($AtStartup) { $t += New-ScheduledTaskTrigger -AtStartup }
  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName CustomHermes -Action $a -Trigger $t -Settings $s -Description 'Custom Hermes supervisor' -Force | Out-Null
  Start-ScheduledTask -TaskName CustomHermes
}

Step 'Hourly heartbeat cron'
Do-It 'add heartbeat cron (skipped if present)' {
  $env:HERMES_HOME = "$InstallDir\hermes-home"
  $list = & $hermes cron list 2>&1 | Out-String
  if ($list -notmatch 'heartbeat') { & $hermes cron create 'every 1h' 'Heartbeat: reply with OK and the current time.' --name heartbeat --deliver local 2>&1 | Out-Host }
}

if (-not $SkipApp) {
  Step 'Build + install Electron app'
  Do-It 'npm install; npm run dist; run installer' {
    Push-Location "$InstallDir\app"
    try {
      npm install --no-audit --no-fund
      npm run dist
      $exe = Get-ChildItem dist -Filter '*Setup*.exe' | Sort-Object LastWriteTime -Desc | Select-Object -First 1
      if ($exe) { Start-Process $exe.FullName -ArgumentList '/S' -Wait; Write-Host "installed $($exe.Name)" } else { Write-Warning 'installer not found in app\dist' }
    } finally { Pop-Location }
  }
}

Step 'Done. Verify:'
Write-Host '  Invoke-RestMethod http://127.0.0.1:8788/v1/models'
Write-Host '  Start-Process http://127.0.0.1:9120'
