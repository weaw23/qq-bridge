@echo off
chcp 65001 >nul
title 哦鲸鲸 · 一键启动
setlocal
set NODE=C:\Users\HCK\AppData\Local\Programs\nodejs\node.exe
set BRIDGE_DIR=D:\qqbot\qq-bridge
set LOGS=D:\qqbot\logs
set CONSOLE=http://127.0.0.1:3100

echo ══════════════════════════════════════════════
echo    🐳 哦鲸鲸 · 一键启动（QQ 3692140164）
echo ══════════════════════════════════════════════
echo.

if not exist "%NODE%" (
  echo [X] 找不到 node.exe：%NODE%
  pause & exit /b 1
)
if not exist "%LOGS%" mkdir "%LOGS%"

echo [1/5] 检查 SnowLuma 网关...
"%NODE%" -e "fetch('http://127.0.0.1:3000/get_login_info',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)}).then(r=>r.json()).then(j=>{console.log(j.retcode===0?'在线':'离线');process.exit(j.retcode===0?0:1)}).catch(()=>{console.log('离线');process.exit(1)})"
if errorlevel 1 (
  echo       → 启动 SnowLuma...
  if exist "D:\qqbot\SnowLuma\launcher.bat" (
    start "" /min "D:\qqbot\SnowLuma\launcher.bat"
    echo       → 等待网关就绪（最多 60 秒）...
    "%NODE%" -e "const t=Date.now();(async()=>{while(Date.now()-t<60000){try{const r=await fetch('http://127.0.0.1:3000/get_login_info',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)});const j=await r.json();if(j.retcode===0){console.log('       ✓ 网关已就绪');process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,2000))}console.log('       ! 网关超时，可稍后在面板里重试');process.exit(0)})()"
  ) else (
    echo       ! 找不到 SnowLuma launcher.bat，请手动启动
  )
) else (
  echo       ✓ 网关已在线
)

echo [2/5] 检查桥接...
"%NODE%" -e "fetch('http://127.0.0.1:3100/api/panel/overview',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>&1
if errorlevel 1 (
  echo       → 启动桥接...
  start "qq-bridge" /min cmd /c ""%NODE%" "%BRIDGE_DIR%\src\bridge.js" >> "%LOGS%\bridge.out.log" 2>> "%LOGS%\bridge.err.log""
  timeout /t 8 /nobreak >nul
  echo       ✓ 桥接已启动
) else (
  echo       ✓ 桥接已在运行
)

echo [3/5] 检查 DSH（127.0.0.1:43120）...
"%NODE%" -e "fetch('http://127.0.0.1:43120/',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>&1
if errorlevel 1 (echo       ! DSH 未响应，请启动 DSH Desktop) else (echo       ✓ DSH 在线)

echo [4/5] 读取控制台令牌...
for /f "delims=" %%t in ('type "%BRIDGE_DIR%\state\console-token"') do set TOKEN=%%t

echo [5/5] 打开控制面板...
start "" "http://127.0.0.1:3100/panel?token=%TOKEN%"
echo.
echo ───────────────────────────────────────────────
"%NODE%" -e "fetch('http://127.0.0.1:3100/api/panel/overview',{headers:{'x-console-token':process.argv[1]}}).then(r=>r.json()).then(o=>{console.log('  状态：QQ '+(o.qq&&o.qq.online?'在线':'离线')+' | SnowLuma '+(o.gateway?'在线':'离线')+' | DSH '+(o.dshReady?'已连':'连接中'));console.log('  模型：'+o.model.provider+'/'+o.model.model+'（思考 '+o.model.reasoningEffort+'）');console.log('  会话：'+o.sessions.length+' | 记忆 '+o.counts.facts+' 条 | 好感度 '+o.counts.affinity+' 人 | 提醒 '+o.counts.reminders+' 条');console.log('  面板：http://127.0.0.1:3100/panel')}).catch(e=>console.log('  状态读取失败：'+e.message))" "%TOKEN%"
echo ───────────────────────────────────────────────
echo.
echo 完成。面板已在浏览器打开（地址里带令牌，直接可用）。
timeout /t 12 /nobreak >nul
