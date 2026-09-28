@echo off
chcp 65001 >nul
title 哦鲸鲸 · 一键启动
setlocal
rem ── 注意：本文件必须是 CRLF 行尾。用 LF 写的话 cmd 会从行中间开始执行，
rem    报一堆 “… is not recognized as an internal or external command”。
set NODE=C:\Users\HCK\AppData\Local\Programs\nodejs\node.exe
if not exist "%NODE%" set NODE=node

rem 真正的启动逻辑在 start-chain.mjs 里（它自己会打印横幅，这里不再重复）
"%NODE%" "D:\qqbot\qq-bridge\ops\start-chain.mjs"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo ⚠️ 启动未完成（退出码 %RC%）。上面 ❌ 那一行就是原因，按提示处理后重新双击本文件即可。
) else (
  echo ✓ 全部就绪。可以关掉这个窗口了。
)
pause
