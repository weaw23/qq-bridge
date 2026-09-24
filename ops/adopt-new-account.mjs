// 新号接管：等 3835811547 登录被 SnowLuma 捕获 → 配端口 → 起 SnowLuma/桥接 → 验证
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const NEW_UIN = '3835811547';
const CFG_DIR = 'D:\\qqbot\\SnowLuma\\config';
const DATA_DIR = 'D:\\qqbot\\SnowLuma\\data';
// 令牌不入库：从 qq-bridge/.snowluma-token 读取（该文件在 .gitignore 中，P8-4 清洗）
const TOKEN_FILE = 'D:\\qqbot\\qq-bridge\\.snowluma-token';
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
if (!TOKEN) throw new Error('OneBot 令牌为空：' + TOKEN_FILE);
const LOGS = 'D:\\qqbot\\logs';
const WD_LOG = path.join(LOGS, 'switch-account.log');
const log = (m) => { const l = `${new Date().toLocaleString('zh-CN')} [switch] ${m}`; fs.appendFileSync(WD_LOG, l + '\n'); console.log(l); };

// 1) 预建新号的 OneBot 配置（标准端口 3000/3001 + 桥接用的 token）
const cfgPath = path.join(CFG_DIR, `onebot_${NEW_UIN}.json`);
if (!fs.existsSync(cfgPath)) {
  const old = JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'onebot_3692140164.json'), 'utf8'));
  old.networks.httpServers[0].port = 3000;
  old.networks.wsServers[0].port = 3001;
  old.networks.httpServers[0].accessToken = TOKEN;
  old.networks.wsServers[0].accessToken = TOKEN;
  fs.writeFileSync(cfgPath, JSON.stringify(old, null, 2));
  log(`已预建 ${path.basename(cfgPath)}（http=3000 ws=3001）`);
} else log('新号配置已存在，跳过预建');

// 2) 起 SnowLuma（带无人值守同意环境变量），让它能捕获新登录
const snowDir = 'D:\\qqbot\\SnowLuma';
const snowNode = fs.existsSync(path.join(snowDir, 'node.exe')) ? path.join(snowDir, 'node.exe') : process.execPath;
function snowlumaRunning() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*index.mjs*' } | Measure-Object).Count"], { encoding: 'utf8' }).trim();
    return Number(out) > 0;
  } catch { return false; }
}
if (!snowlumaRunning()) {
  spawn(snowNode, ['index.mjs'], { cwd: snowDir, detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, SNOWLUMA_ACCEPT_EULA: '1', SNOWLUMA_ACCEPT_PRIVACY: '1' } }).unref();
  log('SnowLuma 已启动（等待新号登录被捕获）');
  await new Promise((r) => setTimeout(r, 25000));
} else log('SnowLuma 已在运行');

// 3) 轮询等新号出现（最多 40 分钟）
const deadline = Date.now() + 40 * 60 * 1000;
let seen = fs.existsSync(path.join(DATA_DIR, NEW_UIN));
if (!seen) log(`等待你登录 ${NEW_UIN}（最长 40 分钟，登录后我自动接管）…`);
while (!seen && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10000));
  seen = fs.existsSync(path.join(DATA_DIR, NEW_UIN));
}
if (!seen) { log('❌ 超时：还没检测到新号登录。你登录后跟我说一声，我立刻接管。'); process.exit(0); }
log(`✅ 检测到新号 ${NEW_UIN} 已登录，开始接管`);

// 4) 端口归位 + 等其他账号让开标准端口
execFileSync('node', ['D:\\qqbot\\switch-account.mjs', NEW_UIN], { stdio: 'inherit' });
log('端口已归位（新号 http=3000 ws=3001）');

// 5) 重启 SnowLuma 让新号占用标准端口
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*index.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { timeout: 20000 });
} catch {}
await new Promise((r) => setTimeout(r, 4000));
spawn(snowNode, ['index.mjs'], { cwd: snowDir, detached: true, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, SNOWLUMA_ACCEPT_EULA: '1', SNOWLUMA_ACCEPT_PRIVACY: '1' } }).unref();
log('SnowLuma 已重启，等待网关（3000）就绪…');

// 6) 等网关 + 验证新号登录
const gw = async () => {
  try {
    const r = await fetch('http://127.0.0.1:3000/get_login_info', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: '{}', signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    return j.retcode === 0 ? j.data : null;
  } catch { return null; }
};
let info = null;
for (let i = 0; i < 40 && !info; i++) { await new Promise((r) => setTimeout(r, 3000)); info = await gw(); }
if (!info) { log('❌ 网关未就绪或新号未登录成功，请检查 SnowLuma WebUI（127.0.0.1:5099）'); process.exit(0); }
log(`✅ 网关就绪：${info.nickname} (${info.user_id})`);

// 7) 清看门狗暂停标记 + 起桥接
try { fs.rmSync('D:\\qqbot\\qq-bridge\\state\\watchdog-pause', { force: true }); } catch {}
const bridgeRunning = () => { try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridge.js*' } | Measure-Object).Count"], { encoding: 'utf8' }).trim() !== '0'; } catch { return false; } };
if (!bridgeRunning()) {
  const out = fs.openSync(path.join(LOGS, 'bridge.out.log'), 'a');
  const err = fs.openSync(path.join(LOGS, 'bridge.err.log'), 'a');
  spawn(process.execPath, ['D:\\qqbot\\qq-bridge\\src\\bridge.js'], { cwd: 'D:\\qqbot\\qq-bridge', detached: true, windowsHide: true,
    stdio: ['ignore', out, err], env: { ...process.env, DSH_HOME: 'C:\\Users\\HCK\\.dsh', DSH_WEB_URL: 'http://127.0.0.1:43120' } }).unref();
  log('桥接已拉起');
  await new Promise((r) => setTimeout(r, 15000));
}

// 8) 最终验证
try {
  const ct = fs.readFileSync('D:\\qqbot\\qq-bridge\\state\\console-token', 'utf8').trim();
  const o = await (await fetch('http://127.0.0.1:3100/api/panel/overview', { headers: { 'x-console-token': ct } })).json();
  log(`✅ 接管完成：桥接 pid ${o.pid} | QQ ${o.qq.nickname}(${o.qq.userId}) 在线=${o.qq.online} | 会话 ${o.sessions.length} | 群白名单 ${o.allowGroups.join(',')}`);
  log('👉 接下来请你做两件事：① 用主人号(1918594889)加她好友 ② 把她拉进你想要的群（她不能自己加群），然后告诉我群号，我加白名单');
} catch (e) { log('⚠️ 最终状态没读到：' + e.message); }
log('===== 接管流程结束 =====');
process.exit(0);
