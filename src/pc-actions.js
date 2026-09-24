// PC 控制动作库（P3-T1/T2）：被 mcp-snowluma-safe.js 的 pc_* 工具引用。
// 安全模型：每个工具调用前必须通过主人私聊会话令牌门禁（在工具注册处经桥接 authorizeRead 校验）。
import { execFile, execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const OUTBOX = 'D:\\qqbot\\outbox';
const MAX_OUTPUT = 12000;   // 直接回传上限（原 4000：读个稍大的文件就被截没了）
const JOBS_DIR = path.join(OUTBOX, 'pc-jobs');
const JOBS_FILE = path.join(JOBS_DIR, 'jobs.json');
const PS_HEAD = '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';

// 输出超长时：头尾都留、中间省略、全文落盘并回传路径。
// 头尾都留是必要的——诊断信息常在末尾（异常栈、最后一条错误），只保留头部会把最关键的部分丢掉。
// 落盘后她可以用 pc_run_command 分页读（Get-Content -TotalCount / Select-Object -Skip）。
function clipOutput(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_OUTPUT) return s || '(无输出)';
  const headLen = Math.floor(MAX_OUTPUT * 0.7);
  const tailLen = Math.floor(MAX_OUTPUT * 0.25);
  const head = s.slice(0, headLen);
  const tail = s.slice(s.length - tailLen);
  let file = '';
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    file = path.join(JOBS_DIR, 'output-' + Date.now() + '.txt');
    fs.writeFileSync(file, s, 'utf8');
  } catch {}
  const note = file
    ? `\n…（中间省略 ${s.length - headLen - tailLen} 字符；全文 ${s.length} 字符已落盘 ${file}，可用 pc_run_command 分页读）`
    : `\n…（中间省略，全文 ${s.length} 字符，落盘失败）`;
  return head + note + '\n──── 尾部 ────\n' + tail;
}

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
          resolve({ ok: false, error: clipOutput(error.killed ? '执行超时' : (err || error.message)) });
          return;
        }
        resolve({ ok: true, output: clipOutput(out + (err ? '\n[stderr] ' + err : '')) });
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

// ── 打字 ─────────────────────────────────────────────────────────────────────
// 为什么用 SendKeys 而不是复用上面的 keybd_event：keybd_event 的 bScan 参数只有 8 位，
// 发不了码点 >255 的字符，中文/emoji 一律打不出来。SendKeys 能正确处理 Unicode。
// 代价是它有自己的转义语法（+ ^ % ~ ( ) { } [ ] 都是特殊字符），必须先转义。
// 文本一律 base64 传入 PowerShell，彻底避开引号/换行/反引号注入。
const SENDKEYS_ESCAPE = /([+^%~(){}[\]])/g;
export async function typeText(text) {
  const t = String(text ?? '');
  if (!t) return { ok: false, error: 'text 不能为空' };
  if (t.length > 4000) return { ok: false, error: '单次打字上限 4000 字符（更长请分段，或用剪贴板粘贴）' };
  const escaped = t.replace(SENDKEYS_ESCAPE, '{$1}');
  const b64 = Buffer.from(escaped, 'utf8').toString('base64');
  const script = `Add-Type -AssemblyName System.Windows.Forms;
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));
[System.Windows.Forms.SendKeys]::SendWait($t);
Write-Output ('typed ' + $t.Length);`;
  const r = await runPS(script, 30000);
  return r.ok
    ? { ok: true, chars: t.length, note: '已输入到「当前前台窗口」。SendKeys 只认前台焦点，打错地方就是焦点不对——先用 pc_window focus 对准目标窗口再打字。' }
    : r;
}

// ── 组合键 ───────────────────────────────────────────────────────────────────
// 组合键不需要 Unicode，所以走 keybd_event（能发 Win 键，SendKeys 发不了）。
const VK = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5B, windows: 0x5B,
  enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B, space: 0x20,
  backspace: 0x08, delete: 0x2E, del: 0x2E, insert: 0x2D, ins: 0x2D,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  printscreen: 0x2C, prtsc: 0x2C, capslock: 0x14,
  playpause: 0xB3, nexttrack: 0xB0, next: 0xB0, prevtrack: 0xB1, prev: 0xB1, medistop: 0xB2,
  volumeup: 0xAF, volumedown: 0xAE, volumemute: 0xAD,
  ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0,
  '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE
};
const MODIFIER_KEYS = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'windows']);
const KEY_HINT = 'a-z、0-9、f1-f24、enter/tab/esc/space/del/ins/home/end/pgup/pgdn/up/down/left/right、ctrl/alt/shift/win、printscreen/capslock';

function vkOf(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  if (VK[n] !== undefined) return VK[n];
  if (/^[a-z]$/.test(n)) return 0x40 + n.charCodeAt(0) - 96;   // a=0x41 … z=0x5A
  if (/^[0-9]$/.test(n)) return 0x30 + Number(n);              // 0=0x30 … 9=0x39
  const f = /^f(\d{1,2})$/.exec(n);
  if (f) { const k = Number(f[1]); if (k >= 1 && k <= 24) return 0x6F + k; }  // F1=0x70 … F24=0x87
  return null;
}

export async function sendKeys(combo, times = 1) {
  const raw = String(combo ?? '').trim();
  if (!raw) return { ok: false, error: 'combo 不能为空，例如 ctrl+s / alt+tab / win+d / ctrl+shift+esc' };
  const n = Math.min(Math.max(Number(times) || 1, 1), 20);
  const parts = raw.split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'combo 解析不出任何键' };
  const mods = [];
  let main = null;
  for (const p of parts) {
    if (MODIFIER_KEYS.has(p)) { mods.push(p); continue; }
    if (main === null) { main = p; continue; }
    return { ok: false, error: `组合键只支持「修饰键 + 一个主键」，但收到两个主键：${main} 和 ${p}` };
  }
  const vkMods = mods.map(vkOf);
  if (vkMods.some((v) => v == null)) return { ok: false, error: '不认识的修饰键：' + mods.join(',') };
  const vkMain = main === null ? null : vkOf(main);
  if (main !== null && vkMain == null) return { ok: false, error: `不认识的键：${main}。支持：${KEY_HINT}` };
  const down = (vk) => `[Win.Key]::keybd_event(${vk},0,0,[UIntPtr]::Zero);`;
  const up = (vk) => `[Win.Key]::keybd_event(${vk},0,2,[UIntPtr]::Zero);`;
  const seq = [];
  for (let i = 0; i < n; i++) {
    for (const m of vkMods) seq.push(down(m));
    if (vkMain != null) { seq.push(down(vkMain)); seq.push(up(vkMain)); }
    for (const m of [...vkMods].reverse()) seq.push(up(m));
    if (i < n - 1) seq.push('Start-Sleep -Milliseconds 60;');
  }
  const r = await runPS(`${KEY_STUB} ${seq.join(' ')} Write-Output 'sent'`, 20000);
  return r.ok ? { ok: true, combo: raw, times: n, note: '已发送到当前前台窗口' } : r;
}

// ── 窗口管理 ─────────────────────────────────────────────────────────────────
const WIN_STUB = "Add-Type -Namespace Win -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);';";
const SW = { minimize: 6, maximize: 3, restore: 9 };   // SW_MINIMIZE / SW_MAXIMIZE / SW_RESTORE
const ACT_LABEL = { focus: '聚焦', minimize: '最小化', maximize: '最大化', restore: '还原', close: '关闭' };

export async function listWindows() {
  const script = `
$w = @(Get-Process | Where-Object { $_.MainWindowTitle } | Sort-Object ProcessName);
if ($w.Count -eq 0) { Write-Output '(当前没有带标题的窗口)' } else {
  foreach ($p in $w) { Write-Output ('pid=' + $p.Id + '  |  ' + $p.ProcessName + '  |  ' + $p.MainWindowTitle) }
  Write-Output ('共 ' + $w.Count + ' 个窗口')
}`;
  const r = await runPS(script, 20000);
  return r.ok ? { ok: true, output: r.output } : r;
}

export async function windowAction(target, action) {
  const act = String(action ?? '').trim().toLowerCase();
  if (!Object.keys(ACT_LABEL).includes(act)) return { ok: false, error: 'action 仅支持 ' + Object.keys(ACT_LABEL).join('/') };
  const t = String(target ?? '').trim();
  if (!t) return { ok: false, error: 'target 不能为空（填 PID，或窗口标题里的关键词）' };
  if (t.length > 120) return { ok: false, error: 'target 过长' };
  const isPid = /^\d+$/.test(t);
  const b64 = Buffer.from(t, 'utf8').toString('base64');
  const finder = isPid
    ? '$p = Get-Process -Id ([int]$t) -ErrorAction SilentlyContinue'
    : '$p = @(Get-Process | Where-Object { $_.MainWindowTitle -like (\'*\' + $t + \'*\') } | Select-Object -First 1)[0]';
  let body;
  if (act === 'focus') {
    // AppActivate 比 SetForegroundWindow 稳：后者受前台锁定限制，非交互进程经常失败
    body = `${WIN_STUB}
$ok = (New-Object -ComObject WScript.Shell).AppActivate([int]$p.Id);
[Win.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;
Write-Output ('已请求聚焦：' + $p.MainWindowTitle + '（AppActivate=' + $ok + '）')`;
  } else if (act === 'close') {
    body = `$ok = $p.CloseMainWindow();
Write-Output ('已请求关闭：' + $p.MainWindowTitle + '（CloseMainWindow=' + $ok + '）')
Write-Output '注：这是礼貌关闭，程序若有未保存内容会自己弹保存框；没有强杀进程。'`;
  } else {
    body = `${WIN_STUB}
$h = $p.MainWindowHandle;
if ($h -eq [IntPtr]::Zero) { Write-Output '该进程没有可操作的主窗口句柄（可能是后台进程）'; exit 1 }
$ok = [Win.W]::ShowWindow($h, ${SW[act]});
Write-Output ('已${ACT_LABEL[act]}：' + $p.MainWindowTitle + '（ShowWindow=' + $ok + '）')`;
  }
  const script = `
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));
${finder};
if (-not $p) { Write-Output ('找不到窗口：' + $t); exit 1 }
${body}`;
  const r = await runPS(script, 20000);
  if (!r.ok) return r;
  if (/找不到窗口/.test(r.output)) return { ok: false, error: r.output };
  return { ok: true, action: act, output: r.output };
}

// ── 剪贴板 ───────────────────────────────────────────────────────────────────
export async function clipboard(action, text) {
  const act = String(action ?? '').trim().toLowerCase();
  if (act === 'get') {
    const r = await runPS(`$c = Get-Clipboard -Raw -ErrorAction SilentlyContinue
if ($null -eq $c -or "$c" -eq '') { Write-Output '(剪贴板为空)' } else { Write-Output $c }`, 15000);
    if (!r.ok) return r;
    return { ok: true, output: r.output, note: '剪贴板可能含密码等敏感内容：只用于当前任务，绝不转发到任何群聊，也别写进记忆。' };
  }
  if (act === 'set') {
    const t = String(text ?? '');
    if (!t) return { ok: false, error: 'set 需要 text' };
    if (t.length > 20000) return { ok: false, error: '剪贴板单次写入上限 20000 字符' };
    const b64 = Buffer.from(t, 'utf8').toString('base64');
    const r = await runPS(`$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
Set-Clipboard -Value $t
Write-Output ('已写入剪贴板 ' + $t.Length + ' 字符')`, 15000);
    return r.ok ? { ok: true, chars: t.length, note: '已覆盖原剪贴板内容（未做备份）' } : r;
  }
  return { ok: false, error: 'action 仅支持 get/set' };
}

// ── 后台长任务 ───────────────────────────────────────────────────────────────
// 动机：runPS 超时硬顶 120 秒，跑个构建/批量转码/大文件处理必然超时，而且她拿不到结果。
// 这里改成脱离式子进程 + 输出落盘 + 轮询查状态。任务表也落盘，所以桥接重启后仍能用
// jobId 继续查（子进程本来就是 detached 的，不随桥接退出）。
function loadJobs() {
  try {
    const j = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch { return {}; }
}
function saveJobs(map) {
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(JOBS_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {}
}
function pidAlive(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return false;
  try { process.kill(p, 0); return true; }
  // 只有 ESRCH 才是「进程不存在」。EPERM 等意味着进程存在但不归我们管，仍须算活着——
  // 否则会把正在跑的长任务误判成已结束（桥接的 acquireLock 用的是同一套判据）。
  catch (error) { return error?.code !== 'ESRCH'; }
}
// 树杀：PowerShell 常会再派生子进程，只杀父进程会留下孤儿
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); return true; } catch { return false; }
}
function readTail(file, max) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.length > max ? '…（前文已省略）\n' + s.slice(-max) : s;
  } catch { return ''; }
}

// 子进程句柄只在内存里。桥接一重启句柄就没了，但注册表还在盘上，
// 于是可以用 bridgePid 判断「这任务是被上一代桥接进程带走的」，如实报 interrupted。
const liveJobs = new Map();
// 主动中止过的任务要报 killed：taskkill /F 之后子进程的 exit 事件照样会来，
// 不记住这个意图就会被退出码伪装成「正常跑完」。
const killRequested = new Set();

export function startJob(cmd, maxMinutes = 30) {
  const c = String(cmd ?? '').trim();
  if (!c) return Promise.resolve({ ok: false, error: '命令不能为空' });
  const cap = Math.min(Math.max(Number(maxMinutes) || 30, 1), 180);
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const psFile = path.join(JOBS_DIR, id + '.ps1');
  const outFile = path.join(JOBS_DIR, id + '.out');
  const errFile = path.join(JOBS_DIR, id + '.err');
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    // 命令原文完整落盘，事后能复查她到底跑了什么（.ps1 只作留档，执行走 -Command，原因见下）
    fs.writeFileSync(psFile, PS_HEAD + c, 'utf8');
    fs.writeFileSync(outFile, '', 'utf8');
    fs.writeFileSync(errFile, '', 'utf8');
  } catch (error) {
    return Promise.resolve({ ok: false, error: '任务文件准备失败：' + (error?.message ?? error) });
  }
  let child;
  try {
    // 这里绝不能用 detached:true —— 它会给子进程 DETACHED_PROCESS 标志（没有控制台）。
    // node.exe 无所谓（看门狗正是这么拉起桥接的），但 powershell.exe 拿不到控制台会立刻退出，
    // 而且 stdout/stderr 一个字节都不留，排查时完全无从下手。
    // 实测对照：detached 的 powershell 100% 秒死（-Command/-File、fd 重定向/stdio inherit 全试过）；
    // 去掉 detached、只留 windowsHide（CREATE_NO_WINDOW，子进程有隐藏控制台）就一切正常。
    // 代价：任务挂在桥接进程下，桥接重启会带走它。注册表记了 bridgePid，
    // 所以那种情况 jobStatus 会如实报 interrupted，而不是假装 finished。
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_HEAD + c], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: 'D:\\qqbot'
    });
  } catch (error) {
    return Promise.resolve({ ok: false, error: '任务启动失败：' + (error?.message ?? error) });
  }
  // 边跑边落盘：长任务也能中途 tail 到进度，而不是等结束才一次性写出来
  child.stdout?.pipe(fs.createWriteStream(outFile, { flags: 'a' }));
  child.stderr?.pipe(fs.createWriteStream(errFile, { flags: 'a' }));

  const jobs = loadJobs();
  jobs[id] = {
    pid: child.pid, bridgePid: process.pid, cmd: c.slice(0, 800), psFile, outFile, errFile,
    startedAt: Date.now(), maxMs: cap * 60000, status: 'running', exitCode: null
  };
  saveJobs(jobs);
  liveJobs.set(id, child);

  let timer = null;
  let done = false;
  const finish = (status, code) => {
    // 必须幂等：超时硬杀会先 finish 一次，随后子进程的 exit 事件还会再来一次
    if (done) return;
    done = true;
    if (timer) { clearTimeout(timer); timer = null; }
    liveJobs.delete(id);
    killRequested.delete(id);
    const cur = loadJobs();
    if (cur[id]) { cur[id].status = status; cur[id].exitCode = code; cur[id].endedAt = Date.now(); saveJobs(cur); }
    console.log('[pc] job end', id, status, 'exit', code);
  };
  child.on('error', () => finish('spawn-error', null));
  child.on('exit', (code, signal) => {
    const st = killRequested.has(id) ? 'killed' : (signal ? 'killed-' + signal : 'finished');
    finish(st, code);
  });
  // 超时硬杀：长任务不能无限占着主人的机器
  timer = setTimeout(() => {
    if (liveJobs.has(id)) { killRequested.add(id); killTree(child.pid); finish('killed-timeout', null); }
  }, cap * 60000);
  timer.unref?.();

  console.log('[pc] job start', id, 'pid', child.pid, c.slice(0, 200));
  return Promise.resolve({
    ok: true, jobId: id, pid: child.pid, maxMinutes: cap, outFile,
    note: `已在后台启动，不占用当前回合。用 pc_job_status 查进度（jobId=${id}），要中止用 pc_job_kill；超过 ${cap} 分钟强制结束。任务挂在桥接进程下，桥接重启会带走它。`
  });
}

export function jobStatus(jobId) {
  const id = String(jobId ?? '').trim();
  const jobs = loadJobs();
  const j = jobs[id];
  if (!j) {
    const known = Object.keys(jobs);
    return Promise.resolve({ ok: false, error: '找不到任务 ' + id + (known.length ? '（现有：' + known.join(', ') + '）' : '（还没有任何任务）') });
  }
  const alive = pidAlive(j.pid);
  const ageMs = Date.now() - Number(j.startedAt || Date.now());
  let status = j.status || 'running';
  if (status === 'running' && alive && ageMs > Number(j.maxMs || 1800000)) {
    // 兜底：正常由 startJob 里的定时器硬杀，这里防的是定时器随桥接重启一起丢失。
    // 但只杀本进程亲手启动的任务——重启之后 pid 可能已被系统复用给别人，盲杀会误伤无关进程。
    if (liveJobs.has(id)) { killRequested.add(id); killTree(j.pid); }
    status = 'killed-timeout';
  } else if (status === 'running' && !alive) {
    // 注册表说在跑、进程却没了。两种可能，必须分开报，不能一律说 finished：
    //  - bridgePid 不是当前进程 → 桥接重启过，任务是被带走的 → interrupted
    //  - 否则是 exit 事件没来得及写盘（极少）→ 按已结束处理
    status = (Number(j.bridgePid) > 0 && Number(j.bridgePid) !== process.pid) ? 'interrupted' : 'finished';
  }
  if (status !== j.status) { j.status = status; saveJobs(jobs); }
  const errTail = readTail(j.errFile, 2000);
  const NOTES = {
    running: '仍在运行，稍后再查（别频繁轮询，隔一两分钟一次就够）',
    finished: `已结束。全文在 ${j.outFile}，可用 pc_run_command 配合 Get-Content 分页读。`,
    interrupted: '任务是被桥接重启带走的，不是正常跑完；下面是已产出的部分，需要就重新起一个',
    'killed-timeout': '超过时限被强制结束；把命令拆小，或用 maxMinutes 放宽时限（上限 180 分钟）',
    killed: '已被中止',
    'spawn-error': '子进程启动失败，看 errorTail'
  };
  return Promise.resolve({
    ok: true, jobId: id, pid: j.pid, status,
    exitCode: j.exitCode ?? null,
    running: status === 'running' && alive,
    elapsedSec: Math.round(ageMs / 1000),
    cmd: j.cmd,
    outputTail: readTail(j.outFile, 6000) || '(暂无输出)',
    errorTail: errTail || '',
    outFile: j.outFile,
    note: NOTES[status] ?? `已结束（${status}）。全文在 ${j.outFile}。`
  });
}

export function jobKill(jobId) {
  const id = String(jobId ?? '').trim();
  const jobs = loadJobs();
  const j = jobs[id];
  if (!j) return Promise.resolve({ ok: false, error: '找不到任务 ' + id });
  if (!pidAlive(j.pid)) {
    if (j.status === 'running') { j.status = 'interrupted'; saveJobs(jobs); }
    return Promise.resolve({ ok: true, jobId: id, status: j.status, note: '进程本来就已经退出了' });
  }
  // 只中止本进程亲手启动的任务：桥接重启后 pid 可能已被系统复用给无关进程，盲杀会误伤
  if (!liveJobs.has(id)) {
    return Promise.resolve({ ok: false, jobId: id, error: '该任务不是当前桥接进程启动的，pid 可能已被系统复用，拒绝盲杀' });
  }
  killRequested.add(id);
  const killed = killTree(j.pid);
  console.log('[pc] job kill', id, 'pid', j.pid, killed);
  if (!killed) {
    killRequested.delete(id);
    return Promise.resolve({ ok: false, jobId: id, status: j.status, error: 'taskkill 失败' });
  }
  return Promise.resolve({ ok: true, jobId: id, status: 'killed', note: '已发出中止，最终状态以 pc_job_status 为准' });
}

export function jobList() {
  const jobs = loadJobs();
  const rows = Object.entries(jobs).map(([id, j]) => ({
    jobId: id,
    pid: j.pid,
    alive: pidAlive(j.pid),
    status: j.status,
    startedAt: new Date(Number(j.startedAt)).toLocaleString('zh-CN', { hour12: false }),
    elapsedSec: Math.round((Date.now() - Number(j.startedAt)) / 1000),
    cmd: String(j.cmd ?? '').slice(0, 120)
  }));
  return Promise.resolve({ ok: true, count: rows.length, jobs: rows });
}
