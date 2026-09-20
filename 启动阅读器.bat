@echo off
setlocal
cd /d "%~dp0"

set "PORT=7789"

rem ---- locate node.exe ----
set "NODE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-2\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
if not defined NODE (
  echo [错误] 找不到 node.exe，请先安装 Node.js
  pause
  exit /b 1
)

rem ---- already listening? just open the page ----
netstat -ano | findstr /r /c:"127.0.0.1:%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo 阅读器已在运行，直接打开页面
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

rem ---- start the server in its own minimized window (title: ReaderServer) ----
start "ReaderServer" /min "%NODE%" "%~dp0server.mjs"

rem ---- wait until it listens, then open the browser ----
for /l %%i in (1,1,40) do (
  netstat -ano | findstr /r /c:"127.0.0.1:%PORT% .*LISTENING" >nul 2>nul
  if not errorlevel 1 goto ready
  timeout /t 1 /nobreak >nul
)
echo [错误] 服务 40 秒内没起来，检查端口 %PORT% 是否被占用
pause
exit /b 1

:ready
echo 阅读器已启动: http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"
exit /b 0
