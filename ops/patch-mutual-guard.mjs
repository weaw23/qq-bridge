// 桥接侧：互相守护——定期确认看门狗活着，不在就静默拉起（windowsHide，无窗口）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let t = fs.readFileSync(BRIDGE, 'utf8');
if (t.includes('互相守护')) throw new Error('已打过互相守护补丁');

const anchor = '  // 提醒扫描器：每 30s 把到期提醒注入对应会话并唤醒（会话仍需在白名单内）。';
const ai = t.indexOf(anchor);
if (ai === -1) throw new Error('找不到锚点');
const lineStart = t.lastIndexOf('\n', ai) + 1;

const patch = `  // ── 互相守护（P5）：桥接定期确认看门狗活着，不在就静默拉起（不弹窗） ──
  // 看门狗负责把桥接/SnowLuma 拉起来；桥接负责把看门狗拉起来 —— 双向兜底，
  // 从而不需要"每分钟跑一次计划任务"（那会每分钟弹一次黑窗口）。
  const WATCHDOG_PATH = path.join(ROOT, '..', 'watchdog.mjs');
  function watchdogAlive() {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\\'node.exe\\'" | Where-Object { $_.CommandLine -like "*watchdog.mjs*" } | Measure-Object | Select-Object -ExpandProperty Count'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      return Number(String(out).trim()) > 0;
    } catch { return false; }
  }
  function ensureWatchdog() {
    try {
      if (!fs.existsSync(WATCHDOG_PATH)) return;
      if (fs.existsSync(path.join(STATE_DIR, 'watchdog-pause'))) return;
      if (watchdogAlive()) return;
      const child = spawn(process.execPath, [WATCHDOG_PATH], {
        cwd: path.join(ROOT, '..'), detached: true, windowsHide: true, stdio: 'ignore', env: process.env
      });
      child.unref();
      log('看门狗不在，已静默拉起（互相守护，pid ' + child.pid + '）');
    } catch (error) {
      log('拉起看门狗失败:', error?.message ?? error);
    }
  }
  const watchdogGuardTimer = setInterval(ensureWatchdog, 3 * 60 * 1000);
  if (watchdogGuardTimer.unref) watchdogGuardTimer.unref();
  setTimeout(ensureWatchdog, 20000);

`;
t = t.slice(0, lineStart) + patch + t.slice(lineStart);
fs.writeFileSync(BRIDGE, t);
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ 桥接互相守护补丁完成，syntax OK');
