// PC 控制动作库（P3-T1/T2）：被 mcp-snowluma-safe.js 的 pc_* 工具引用。
// 安全模型：每个工具调用前必须通过主人私聊会话令牌门禁（在工具注册处经桥接 authorizeRead 校验）。
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const OUTBOX = 'D:\\qqbot\\outbox';
const MAX_OUTPUT = 4000;
const PS_HEAD = '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';

export function runPS(script, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_HEAD + script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '').trim();
        const err = String(stderr ?? '').trim();
        if (error && !out) {
          resolve({ ok: false, error: (error.killed ? '执行超时' : (err || error.message)).slice(0, MAX_OUTPUT) });
          return;
        }
        resolve({ ok: true, output: (out + (err ? '\n[stderr] ' + err : '')).slice(0, MAX_OUTPUT) || '(无输出)' });
      }
    );
  });
}

// keybd_event P/Invoke：音量/媒体键（SendKeys 发不了多媒体键）
const KEY_STUB = "Add-Type -Namespace Win -Name Key -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);';";
function tapKey(vk, times) {
  const seq = [];
  for (let i = 0; i < times; i++) seq.push(`[Win.Key]::keybd_event(${vk},0,0,[UIntPtr]::Zero); [Win.Key]::keybd_event(${vk},0,2,[UIntPtr]::Zero);`);
  return runPS(`${KEY_STUB} ${seq.join(' ')} Write-Output 'done'`, 15000);
}

export async function sysInfo() {
  const script = `
$os = Get-CimInstance Win32_OperatingSystem;
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;
$bat = Get-CimInstance Win32_Battery | Select-Object -First 1;
$up = (Get-Date) - $os.LastBootUpTime;
Write-Output ("CPU 负载: $cpu%");
Write-Output ("内存: 已用 $([math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1))GB / 共 $([math]::Round($os.TotalVisibleMemorySize/1MB,1))GB");
Write-Output ("开机时长: $([int]$up.TotalHours) 小时 $($up.Minutes) 分");
if ($bat) { Write-Output ("电量: $($bat.EstimatedChargeRemaining)%") } else { Write-Output '电源: 台式机/无电池' };
Write-Output '磁盘:';
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { Write-Output ("  $($_.DeviceID) 剩余 $([math]::Round($_.FreeSpace/1GB,1))GB / 共 $([math]::Round($_.Size/1GB,1))GB") };
`;
  return runPS(script, 30000);
}

export async function screenshot() {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const file = path.join(OUTBOX, 'screenshot-' + Date.now() + '.png');
  const psFile = file.replace(/'/g, '');
  const script = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms;
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);
$g.Dispose();
$bmp.Save('${psFile}', [System.Drawing.Imaging.ImageFormat]::Png);
$bmp.Dispose();
Write-Output 'saved';`;
  const r = await runPS(script, 30000);
  if (!r.ok) return r;
  if (!fs.existsSync(file)) return { ok: false, error: '截图未生成：' + r.output };
  const url = 'file:///' + file.replace(/\\/g, '/');
  return { ok: true, file, size: fs.statSync(file).size, note: '已存到 outbox。用 qq_send_image 发送（file 参数填 ' + url + '）。截图可能含隐私内容，只准发给主人私聊。' };
}

const VOL_KEY = { up: '0xAF', down: '0xAE', mute: '0xAD' };
export async function volume(action, steps = 1) {
  const vk = VOL_KEY[String(action ?? '').trim()];
  if (!vk) return { ok: false, error: 'action 仅支持 up/down/mute' };
  const n = Math.min(Math.max(Number(steps) || 1, 1), 50);
  const r = await tapKey(vk, n);
  return r.ok ? { ok: true, action, steps: n, note: '已调整（系统不回报具体音量值）' } : r;
}

const MEDIA_KEY = { playpause: '0xB3', next: '0xB0', prev: '0xB1', stop: '0xB2' };
export async function media(action) {
  const vk = MEDIA_KEY[String(action ?? '').trim()];
  if (!vk) return { ok: false, error: 'action 仅支持 playpause/next/prev/stop' };
  const r = await tapKey(vk, 1);
  return r.ok ? { ok: true, action, note: '已发送媒体键' } : r;
}

export async function openUrl(url) {
  const u = String(url ?? '').trim();
  if (!/^https?:\/\/[^\s'"<>]+$/i.test(u)) return { ok: false, error: '仅支持 http(s) 链接' };
  const r = await runPS(`Start-Process '${u.replace(/'/g, '')}'; Write-Output 'opened'`, 15000);
  return r.ok ? { ok: true, url: u } : r;
}

const APP_ALLOW = ['notepad', 'calc', 'mspaint', 'explorer', 'taskmgr', 'cmd', 'code', 'msedge', 'chrome', 'cloudmusic'];
export async function openApp(name) {
  const app = String(name ?? '').trim().toLowerCase();
  if (!APP_ALLOW.includes(app)) return { ok: false, error: '应用不在白名单。允许：' + APP_ALLOW.join(', ') };
  const r = await runPS(`Start-Process '${app}'; Write-Output 'opened'`, 15000);
  return r.ok ? { ok: true, app } : r;
}

export async function lockScreen() {
  return new Promise((resolve) => {
    execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true, timeout: 10000 }, (error) => {
      resolve(error ? { ok: false, error: error.message } : { ok: true, note: '已锁屏' });
    });
  });
}

export function runCommand(cmd, timeoutSec = 30) {
  const c = String(cmd ?? '').trim();
  if (!c) return Promise.resolve({ ok: false, error: '命令不能为空' });
  const t = Math.min(Math.max(Number(timeoutSec) || 30, 1), 120);
  console.log('[pc] run_command by owner:', c.slice(0, 200));
  return runPS(c, t * 1000);
}
