@echo off
setlocal enabledelayedexpansion
set "PORT=7788"
set "N=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    taskkill /f /pid %%p >nul 2>nul
    if !errorlevel! equ 0 (echo 已停止阅读器，PID %%p) else (echo 停止失败，PID %%p)
    set /a N+=1
  )
)
if !N! equ 0 echo 阅读器未在运行
echo.
pause
