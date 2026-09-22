@echo off
chcp 65001 >nul
echo ============================================
echo  让 Edge 开启 CDP 调试端口（9222）
echo  会关闭现有 Edge 窗口，标签页会自动恢复
echo ============================================
echo.
set EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" set EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" (
  echo [X] 找不到 msedge.exe，请手动确认 Edge 安装路径
  pause
  exit /b 1
)
echo [1/3] 关闭现有 Edge...
taskkill /IM msedge.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul
echo [2/3] 以调试模式启动（标签页恢复中）...
start "" "%EDGE%" --remote-debugging-port=9222 --restore-last-session
timeout /t 4 /nobreak >nul
echo [3/3] 检查调试端口...
node "C:\Users\HCK\.dsh\skills\web-access\cdp.mjs" status
echo.
echo 完成。之后 agent 就能通过 CDP 操作你现在这个浏览器了。
pause
