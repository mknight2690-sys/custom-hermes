# Grok Replica

A local, always-on personal AI agent for **Windows 10/11**. It is a separate
[Hermes Agent](https://github.com/NousResearch/hermes-agent) home wired to a
free-model **autoselector** (OpenAI-compatible proxy, model `auto`), kept alive
24/7 by a supervisor + scheduled task, with a sleek **Electron desktop app**
(tray icon) wrapping the Hermes dashboard.

| Component | Where | Port |
|---|---|---|
| Autoselector (`autoselector/autoselector.py`) | `%USERPROFILE%\GrokReplica\autoselector` | `127.0.0.1:8788` |
| Hermes dashboard | `hermes dashboard` | `127.0.0.1:9120` |
| Hermes gateway (runs cron jobs) | `hermes gateway` | - |
| Supervisor (`supervisor.ps1`, checks every 15 s) | scheduled task `GrokReplica` | - |
| Desktop app (`app/`) | installed per-user, Desktop + Start menu shortcut | - |

---

## For AI agents: install top to bottom

Run every block in **PowerShell** (normal user; only step 6b needs admin).
Each step is idempotent: rerunning is safe.

### 0. Fast path (does steps 1-7 automatically)

```powershell
git clone https://github.com/mknight2690-sys/grok-replica.git $env:TEMP\grok-replica
cd $env:TEMP\grok-replica
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun   # preview
powershell -ExecutionPolicy Bypass -File .\install.ps1            # install
```
Flags: `-InstallDir <path>` (default `%USERPROFILE%\GrokReplica`), `-SkipApp`,
`-SkipHermesInstall`, `-AtStartup` (adds a boot trigger; needs admin).
Then add keys (step 3) and run the checklist (section "Verify").

### 1. Prerequisites check

```powershell
python --version   # expect Python 3.10+   (else: winget install -e --id Python.Python.3.12)
node --version     # expect v18+ (only for the app; else: winget install -e --id OpenJS.NodeJS.LTS)
git --version
Get-Command hermes -EA 0   # empty = Hermes not installed yet
```
The autoselector uses only the Python standard library (no pip installs).

### 2. Install Hermes Agent (official Nous Research installer)

Verify against the current docs first: <https://github.com/NousResearch/hermes-agent#quick-install>.
At time of writing the native Windows command is:
```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```
Open a new PowerShell, then `hermes --version`. Default location:
`%LOCALAPPDATA%\hermes\bin\hermes.exe`. If `hermes` is not on PATH, pass the
full path via `-Hermes` / `$env:GROK_REPLICA_HERMES`.

### 3. Supply free-model keys

The autoselector cycles Nous Portal free models across all your keys and falls
back to keyless Pollinations if none work. Get keys at <https://portal.nousresearch.com>.
```powershell
$d="$env:USERPROFILE\GrokReplica\autoselector"
Copy-Item "$d\nous_keys.example.txt" "$d\nous_keys.txt"
notepad "$d\nous_keys.txt"     # one key per line, lines starting with # ignored
```
Alternatives: env var `NOUS_API_KEY` (single key) or `NOUS_KEYS_FILE` (path to
a key file elsewhere). `nous_keys.txt` and `state.json` are git-ignored: never commit them.

### 4. Layout after install

```
%USERPROFILE%\GrokReplica\
  autoselector\autoselector.py   nous_keys.txt (yours)   state.json (runtime)
  hermes-home\config.yaml        (HERMES_HOME for this replica: memory, sessions, cron)
  app\                           Electron source (main.js, shell.html, theme.css, build\ icons)
  icons\                         icon.ico icon.png tray.ico tray32.png tray16.png
  logs\                          supervisor.log, <service>.out/.err.log
  supervisor.ps1
```

### 5. Configure Hermes

`config/config.yaml.template` is copied to `hermes-home\config.yaml` (only if absent):
```yaml
model:
  provider: custom
  base_url: http://127.0.0.1:8788/v1
  default: auto
  api_key: local
  context_length: 64000
```
Always set `$env:HERMES_HOME="$env:USERPROFILE\GrokReplica\hermes-home"` before
running `hermes` commands for the replica, so it stays isolated from any other Hermes install.

### 6. Start services / persistence

a) Register the supervisor task (what install.ps1 does):
```powershell
$R="$env:USERPROFILE\GrokReplica"; $H=(Get-Command hermes).Source
$a=New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$R\supervisor.ps1`" -Root `"$R`" -Hermes `"$H`"" -WorkingDirectory $R
$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName GrokReplica -Action $a -Trigger $t -Settings $s -Force
Start-ScheduledTask GrokReplica
```
b) Optional, 24/7 while powered on: run install.ps1 with `-AtStartup` from an
admin shell, and stop sleep on AC power: `powercfg /change standby-timeout-ac 0`.

c) Heartbeat cron (proves the scheduler works):
```powershell
$env:HERMES_HOME="$env:USERPROFILE\GrokReplica\hermes-home"
hermes cron create 'every 1h' 'Heartbeat: reply with OK and the current time.' --name heartbeat --deliver local
```

### 7. Build + install the Electron app

```powershell
cd "$env:USERPROFILE\GrokReplica\app"
npm install --no-audit --no-fund
npm run dist                                   # -> dist\Grok Replica Setup 1.0.1.exe
Start-Process (Get-ChildItem dist -Filter '*Setup*.exe')[0].FullName -ArgumentList '/S' -Wait
```
The app is frameless and dark, embeds `http://127.0.0.1:9120` in a themed
webview, starts the `GrokReplica` task if services are down, hides to tray on
close (tray menu: Open / Restart services / Quit). Set `GROK_REPLICA_DEBUG=1`
to enable remote debugging on 9229 (off by default).

---

## Verify (expected outputs)

```powershell
Get-ScheduledTask GrokReplica | Select TaskName,State          # State: Running
Get-NetTCPConnection -State Listen -LocalPort 8788,9120 | Select LocalPort   # both listed
Invoke-RestMethod http://127.0.0.1:8788/v1/models              # JSON model list
Invoke-RestMethod http://127.0.0.1:8788/health                 # JSON stats (may be {} at first)
$b=@{model='auto';messages=@(@{role='user';content='Say OK'})}|ConvertTo-Json -Depth 5
(Invoke-RestMethod http://127.0.0.1:8788/v1/chat/completions -Method Post -Body $b -ContentType application/json).choices[0].message.content   # "OK"
(Invoke-WebRequest http://127.0.0.1:9120 -UseBasicParsing).StatusCode   # 200
$env:HERMES_HOME="$env:USERPROFILE\GrokReplica\hermes-home"; hermes cron status   # "Gateway is running"
hermes cron list                                                # heartbeat [active]
Get-Content "$env:USERPROFILE\GrokReplica\logs\supervisor.log" -Tail 5
```
Self-heal test: `Get-NetTCPConnection -LocalPort 8788 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`,
wait 30 s, port 8788 is listening again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| 8788 not listening | check `logs\autoselector.err.log`; `python autoselector\autoselector.py` in foreground (set `$env:PORT=8788`) |
| Replies slow or empty | add more keys to `nous_keys.txt`; Pollinations fallback is slow |
| 9120 not listening | `hermes dashboard --help`; if `--skip-build` fails on first run, run `hermes dashboard` once without it |
| Cron jobs never run | gateway must run: `hermes cron status`; supervisor restarts it every 5 min if down |
| Defender quarantines `uv.exe` | see the Hermes README troubleshooting (false positive) |
| Task runs but nothing starts | run `supervisor.ps1 -Root <dir>` manually in a visible window to see errors; a stale `Global\GrokReplicaSupervisor` mutex means another copy is already running |
| Port clash | `supervisor.ps1 -AutoPort 8790 -DashPort 9121` and update `config.yaml` / app `main.js` / `shell.html` to match |

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1            # removes task, processes, app, install dir
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepData  # keep hermes-home + keys
```

## Security

No keys ship in this repo. Everything binds to `127.0.0.1` only.

## License

MIT
