!macro NSIS_HOOK_PREINSTALL
  ; The Tauri host normally owns this child. An unclean host exit can leave the
  ; bundled Node worker alive and lock runtime\node.exe during an upgrade.
  StrCpy $0 "$INSTDIR\runtime\node.exe"
  System::Call 'kernel32::SetEnvironmentVariable(t, t) i ("TMALL_INSTALL_NODE", r0)'
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target = [System.IO.Path]::GetFullPath($$env:TMALL_INSTALL_NODE); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath) -ieq $$target) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 700"' $1
  Sleep 300
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Apply the same cleanup when uninstall is invoked directly.
  StrCpy $0 "$INSTDIR\runtime\node.exe"
  System::Call 'kernel32::SetEnvironmentVariable(t, t) i ("TMALL_INSTALL_NODE", r0)'
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target = [System.IO.Path]::GetFullPath($$env:TMALL_INSTALL_NODE); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ([System.IO.Path]::GetFullPath($$_.ExecutablePath) -ieq $$target) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 700"' $1
  Sleep 300
!macroend
