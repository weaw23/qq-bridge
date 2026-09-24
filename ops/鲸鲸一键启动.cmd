@echo off
chcp 65001 >nul
title 哦鲸鲸 · 一键启动
setlocal
set NODE=C:\Users\HCK\AppData\Local\Programs\nodejs\node.exe
if not exist "%NODE%" set NODE=node

echo ══════════════════════════════════════════════
echo    🐳 哦鲸鲸 · 一键启动
echo ══════════════════════════════════════════════

"%NODE%" "D:\qqbot\qq-bridge\ops\start-chain.mjs"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo ⚠️ 启动未完成（退出码 %RC%）。上面 ❌ 那一行就是原因，按提示处理后重新双击本文件即可。
) else (
  echo ✓ 全部就绪。可以关掉这个窗口了。
)
echo ───────────────────────────────────────────────
pause
