# Custom Hermes

A local, always-on personal AI agent for **Windows 10/11**. It is a separate
[Hermes Agent](https://github.com/NousResearch/hermes-agent) home wired to a
free-model **autoselector** (OpenAI-compatible proxy, model `auto`), kept alive
24/7 by a supervisor + scheduled task, with a sleek **Electron desktop app**
(tray icon) wrapping the Hermes dashboard.

| Component | Where | Port |
|---|---|---|
| Autoselector (`autoselector/autoselector.py`) | `%USERPROFILE%\Custom-Hermes\autoselector` | `127.0.0.1:8788` |
| Hermes dashboard | `hermes dashboard` | `127.0.0.1:9120` |
| Hermes gateway (runs cron jobs) | `hermes gateway` | - |
| Supervisor (`supervisor.ps1`, checks every 15 s) | scheduled task `CustomHermes` | - |
| Desktop app (`app/`) | installed per-user, Desktop + Start menu shortcut | - |

> **Custom Hermes is an independent customization built on the open-source [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research. It is not an official Nous Research product and is not affiliated with or endorsed by Nous Research.**

## Download

**[Download Custom Hermes Setup 1.1.0 for Windows](https://github.com/mknight2690-sys/custom-hermes/releases/latest/download/Custom-Hermes-Setup-1.1.0.exe)** (78.6 MB, unsigned: on SmartScreen click *More info* then *Run anyway*).

Install the app only: run `Custom-Hermes-Setup-1.1.0.exe`; it still needs the services from the AI-agent install below (Hermes + autoselector + supervisor) to show the dashboard.

---

## For AI agents: install top to bottom

Run every block in **PowerShell** (normal user; only step 6b needs admin).
Each step is idempotent: rerunning is safe.

### 0. Fast path (does steps 1-7 automatically)

```powershell
git clone https://github.com/mknight2690-sys/custom-hermes.git $env:TEMP\custom-hermes
cd $env:TEMP\custom-hermes
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun   # preview
powershell -ExecutionPolicy Bypass -File .\install.ps1            # install
```
Flags: `-InstallDir <path>` (default `%USERPROFILE%\Custom-Hermes`), `-SkipApp`,
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
full path via `-Hermes` / `$env:CUSTOM_HERMES_HERMES`.

### 3. Supply free-model keys

The autoselector cycles Nous Portal free models across all your keys and falls
back to keyless Pollinations if none work. Get keys at <https://portal.nousresearch.com>.
```powershell
$d="$env:USERPROFILE\Custom-Hermes\autoselector"
Copy-Item "$d\nous_keys.example.txt" "$d\nous_keys.txt"
notepad "$d\nous_keys.txt"     # one key per line, lines starting with # ignored
```
Alternatives: env var `NOUS_API_KEY` (single key) or `NOUS_KEYS_FILE` (path to
a key file elsewhere). `nous_keys.txt` and `state.json` are git-ignored: never commit them.

### 4. Layout after install

```
%USERPROFILE%\Custom-Hermes\
  autoselector\autoselector.py   nous_keys.txt (yours)   state.json (runtime)
  hermes-home\config.yaml        (HERMES_HOME for Custom Hermes: memory, sessions, cron)
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
Always set `$env:HERMES_HOME="$env:USERPROFILE\Custom-Hermes\hermes-home"` before
running `hermes` commands for Custom Hermes, so it stays isolated from any other Hermes install.

### 6. Start services / persistence

a) Register the supervisor task (what install.ps1 does):
```powershell
$R="$env:USERPROFILE\Custom-Hermes"; $H=(Get-Command hermes).Source
$a=New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$R\supervisor.ps1`" -Root `"$R`" -Hermes `"$H`"" -WorkingDirectory $R
$t=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName CustomHermes -Action $a -Trigger $t -Settings $s -Force
Start-ScheduledTask CustomHermes
```
b) Optional, 24/7 while powered on: run install.ps1 with `-AtStartup` from an
admin shell, and stop sleep on AC power: `powercfg /change standby-timeout-ac 0`.

c) Heartbeat cron (proves the scheduler works):
```powershell
$env:HERMES_HOME="$env:USERPROFILE\Custom-Hermes\hermes-home"
hermes cron create 'every 1h' 'Heartbeat: reply with OK and the current time.' --name heartbeat --deliver local
```

### 7. Build + install the Electron app

```powershell
cd "$env:USERPROFILE\Custom-Hermes\app"
npm install --no-audit --no-fund
npm run dist                                   # -> dist\Custom Hermes Setup 1.0.1.exe
Start-Process (Get-ChildItem dist -Filter '*Setup*.exe')[0].FullName -ArgumentList '/S' -Wait
```
The app is frameless and dark, embeds `http://127.0.0.1:9120` in a themed
webview, starts the `CustomHermes` task if services are down, hides to tray on
close (tray menu: Open / Restart services / Quit). Set `CUSTOM_HERMES_DEBUG=1`
to enable remote debugging on 9229 (off by default).

---

## Trading tab (v1.1.0)

The desktop app has a **Dashboard | Trading** tab bar. The Trading tab is a BloFin futures panel:

- **Connection:** Demo/Live toggle; API key, secret and passphrase fields with show/hide; **Select API file** opens a local `.txt`/`.json`/`.env` file and fills the fields (labels like `API Key:`, `KEY=value`, JSON, or 3 bare lines). It shows which fields were found. The file is read locally and never uploaded.
- **Save** encrypts the keys with Windows DPAPI (Electron `safeStorage`) in `%APPDATA%\Custom Hermes\blofin.cred`. Keys are never logged and never shown again in full. All signed API calls run in the main process.
- **Account:** equity, available balance, margin used and unrealized PnL. **Positions** have inline TP/SL editing plus a close button. **Open orders** and **TP/SL orders** are listed separately and can be cancelled.
- **Order form:** market or limit orders. It shows the margin percentage, plus the projected PnL at TP and SL and the R:R. Built-in rules: margin = max(1.50 USDT, 10% of equity), R:R ≥ 2.5, 5x isolated, and a stop loss is required. A confirmation dialog appears before any order is sent.
- **Chart:** candles from BloFin public market data, drawn with a bundled copy of TradingView lightweight-charts. It has an instrument search, a timeframe picker and a round reset-chart button.
- **Voice:** spoken "BTC long opened" / "BTC long closed" alerts. The first snapshot after connecting is a silent baseline. A close is only announced after 2 polls, and alerts are queued with a cap. A mute setting is saved.
- Test mode: `CUSTOM_HERMES_TEST=1` (hidden window) and `CUSTOM_HERMES_MOCK=1` (mock account; orders blocked).

## Verify (expected outputs)

```powershell
Get-ScheduledTask CustomHermes | Select TaskName,State          # State: Running
Get-NetTCPConnection -State Listen -LocalPort 8788,9120 | Select LocalPort   # both listed
Invoke-RestMethod http://127.0.0.1:8788/v1/models              # JSON model list
Invoke-RestMethod http://127.0.0.1:8788/health                 # JSON stats (may be {} at first)
$b=@{model='auto';messages=@(@{role='user';content='Say OK'})}|ConvertTo-Json -Depth 5
(Invoke-RestMethod http://127.0.0.1:8788/v1/chat/completions -Method Post -Body $b -ContentType application/json).choices[0].message.content   # "OK"
(Invoke-WebRequest http://127.0.0.1:9120 -UseBasicParsing).StatusCode   # 200
$env:HERMES_HOME="$env:USERPROFILE\Custom-Hermes\hermes-home"; hermes cron status   # "Gateway is running"
hermes cron list                                                # heartbeat [active]
Get-Content "$env:USERPROFILE\Custom-Hermes\logs\supervisor.log" -Tail 5
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
| Task runs but nothing starts | run `supervisor.ps1 -Root <dir>` manually in a visible window to see errors; a stale `Global\Custom-HermesSupervisor` mutex means another copy is already running |
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

## Trading tabs (v1.1.0)

- **B Trading** (BloFin), **P Trading** (Propr), **C Trading** (Coinbase): account, positions with TP/SL edit, order form with projected PnL, open orders + TP/SL, chart with reset, PnL share badge, winner/loser/breakeven voice.
- Rules enforced: margin = max(1.50, 10% equity), R:R >= 2.5, 5x isolated, stop mandatory.
- Per-exchange API file picker/parser (Coinbase: no passphrase; USD/USDC shown).
- P Trading sub-tabs per challenge/funded account, labelled with Propr's own names (e.g. 'Free Trial', '5K Starter 1-Step Turbo Challenge'), with drawdown floor, daily loss left, target, win rate and payout (derived values marked).
- Updates: no in-app updater; reinstall the latest Setup exe (silent reinstall relaunches the app).

