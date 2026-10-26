param([string]$InstallDir = "$env:USERPROFILE\GrokReplica", [switch]$KeepData)
Unregister-ScheduledTask -TaskName GrokReplica -Confirm:$false -EA 0
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$InstallDir*" } | ForEach-Object { taskkill /T /F /PID $_.ProcessId | Out-Null }
$u = Get-ChildItem "$env:LOCALAPPDATA\Programs\grok-replica" -Filter 'Uninstall*.exe' -EA 0 | Select-Object -First 1
if ($u) { Start-Process $u.FullName -ArgumentList '/S' -Wait }
if (-not $KeepData) { Remove-Item $InstallDir -Recurse -Force -EA 0 }
Write-Host 'Grok Replica removed. Hermes Agent itself is left installed (remove via its own uninstaller if wanted).'
