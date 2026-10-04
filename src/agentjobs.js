// agentjobs.js — 鲸鲸 3.0 P3：受控后台长任务（Agent 干实事）
// 设计：
//   - 命令白名单（config.agentJobs.allow，整条命令正则匹配）命中 → 直接跑
//   - 未命中白名单 → 走主人审批：挂 pendingApprovals，通知主人，/job ok|no 处理；
//     审批通过后按「归一化命令」哈希记入 approvals，同命令后续免审
//   - 危险命令黑名单无条件拦截（即使白名单/已审批也拒绝）
//   - 产物：state/agent-jobs/<id>.out.log / .err.log（追加式落盘，重启不丢）
//   - 注册表 state/agent-jobs.json 持久化（进程重启后 running 但 pid 已死 → 标 aborted）
//   - 完成/失败回调 onFinished(job) → 桥接插一条 reminders（mode 'ai'）唤醒她报告结果
//   - 超时（maxMinutes，上限 180）自动杀进程树（taskkill /T /F）

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_MINUTES_CAP = 180;
const MAX_HISTORY = 200;
const MAX_PENDING = 20;

const DANGEROUS = [
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bStop-Computer\b|\bRestart-Computer\b|\bReset-Computer\b/i,
  /\breg\s+(add|delete|import|load|restore)\b/i,
  /\brd\s+\/s\b/i,
  /\bdel\s+\/[fs]/i,
  /\bRemove-Item\b[^\n]{0,200}-Recurse[^\n]{0,200}-Force/i,
  /\btaskkill\b[^\n]{0,100}\/f[^\n]{0,100}\/im\b/i,
  /\bmklink\b|\bsubst\b/i,
  /\bbcdedit\b|\bdiskpart\b|\bcipher\b\s+\/w/i,
  /\bnet\s+(user|localgroup)\b/i,
  /\bschtasks\s+\/create\b/i,
  /\bsc\s+(create|delete)\b/i
];

function normalizeCommand(cmd) {
  return String(cmd ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function commandHash(cmd) {
  return crypto.createHash('sha1').update(normalizeCommand(cmd)).digest('hex').slice(0, 16);
}

function now36() {
  return Date.now().toString(36);
}

function randId() {
  return crypto.randomBytes(4).toString('hex');
}

export function createAgentJobsModule({ cfg, log, appendActivity, onFinished, onNeedApproval }) {
  const section = cfg.agentJobs ?? {};
  const stateDir = path.join(path.dirname(cfg._configPath ?? 'config.json'), 'state');
  const jobsDir = path.join(stateDir, 'agent-jobs');
  const regFile = path.join(jobsDir, 'agent-jobs.json');
  fs.mkdirSync(jobsDir, { recursive: true });

  const allowRules = Array.isArray(section.allow) ? section.allow : [];
  const maxConcurrent = Math.max(1, Math.min(Number(section.maxConcurrent) || 2, 4));
  const defaultMaxMinutes = Math.max(1, Math.min(Number(section.maxMinutes) || 30, MAX_MINUTES_CAP));
  const cwd = section.cwd || process.cwd();
  const timers = new Map(); // jobId -> timeout
  // Bug #8/#9：日志流必须集中托管，否则 kill() 与 spawn 同步抛错两条路径
  // 都拿不到流 → 永不 end → 文件句柄泄漏 + 缓冲不刷盘（日志尾部丢失）。
  const streams = new Map(); // jobId -> { out, err }

  function closeStreams(id) {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    try { s.out.end(); } catch {}
    try { s.err.end(); } catch {}
  }

  let reg = { jobs: [], approvals: {}, pendingApprovals: [] };
  try {
    if (fs.existsSync(regFile)) reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  } catch (error) {
    log('agent-jobs 注册表读取失败，重建: ' + (error?.message ?? error));
  }
  if (!Array.isArray(reg.jobs)) reg.jobs = [];
  if (!reg.approvals || typeof reg.approvals !== 'object') reg.approvals = {};
  if (!Array.isArray(reg.pendingApprovals)) reg.pendingApprovals = [];

  // 启动恢复：running 但 pid 已死 → aborted
  for (const j of reg.jobs) {
    if (j.status !== 'running') continue;
    let alive = false;
    try { process.kill(j.pid, 0); alive = true; } catch { /* 已退出 */ }
    if (!alive) { j.status = 'aborted'; j.finishedAt = Date.now(); j.note = '桥接重启时进程已不在'; }
  }

  function save() {
    try { fs.writeFileSync(regFile, JSON.stringify(reg)); }
    catch (error) { log('agent-jobs 注册表写入失败: ' + (error?.message ?? error)); }
  }
  save();

  function enabled() { return section.enabled !== false; }

  function matchAllow(cmd) {
    const c = String(cmd).trim();
    for (const rule of allowRules) {
      const re = rule?.match;
      if (!re) continue;
      try { if (new RegExp(re).test(c)) return rule.name || '白名单'; } catch { /* 规则坏了跳过 */ }
    }
    return null;
  }

  function dangerous(cmd) {
    const c = String(cmd);
    for (const re of DANGEROUS) if (re.test(c)) return re.source;
    return null;
  }

  function publicJob(j) {
    return { id: j.id, label: j.label || null, command: j.command, status: j.status, exitCode: j.exitCode ?? null, pid: j.pid ?? null, startedAt: j.startedAt, finishedAt: j.finishedAt ?? null, runtimeSec: j.runtimeSec ?? null, timeoutMin: j.timeoutMin ?? null, requestedBy: j.requestedBy || null, followupKey: j.followupKey || null, note: j.note || null };
  }

  function trimHistory() {
    const fin = reg.jobs.filter((j) => j.status !== 'running' && j.status !== 'awaiting');
    if (reg.jobs.length - fin.length + fin.length > MAX_HISTORY) {
      const keep = fin.slice(-Math.max(0, MAX_HISTORY - (reg.jobs.length - fin.length)));
      const keepIds = new Set(keep.map((j) => j.id));
      for (const j of fin) {
        if (!keepIds.has(j.id)) {
          for (const ext of ['.out.log', '.err.log']) { try { fs.rmSync(path.join(jobsDir, j.id + ext)); } catch {} }
        }
      }
      reg.jobs = reg.jobs.filter((j) => keepIds.has(j.id) || j.status === 'running' || j.status === 'awaiting');
    }
    if (reg.pendingApprovals.length > MAX_PENDING) reg.pendingApprovals = reg.pendingApprovals.slice(-MAX_PENDING);
  }

  function readTail(file, maxBytes) {
    try {
      const st = fs.statSync(file);
      const start = Math.max(0, st.size - maxBytes);
      const fd = fs.openSync(file, 'r');
      try {
        const len = st.size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return ''; }
  }

  function actuallyStart(entry) {
    const j = entry;
    const id = j.id;
    const outFile = path.join(jobsDir, id + '.out.log');
    const errFile = path.join(jobsDir, id + '.err.log');
    const outStream = fs.createWriteStream(outFile, { flags: 'a' });
    const errStream = fs.createWriteStream(errFile, { flags: 'a' });
    streams.set(id, { out: outStream, err: errStream });
    outStream.write(`# ${new Date().toISOString()} start: ${j.command}\n`);
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', j.command], {
        cwd, windowsHide: true
      });
    } catch (error) {
      // Bug #9：cwd 不存在等情况 Node 会同步抛 ENOENT —— 流已建但没人管，
      // 不显式关就是句柄泄漏 + 空日志文件留盘。
      closeStreams(id);
      j.status = 'failed'; j.finishedAt = Date.now(); j.note = 'spawn 失败: ' + (error?.message ?? error);
      save();
      return { ok: false, error: j.note };
    }
    j.pid = child.pid; j.status = 'running'; j.startedAt = Date.now(); j.approved = j.approved || false;
    save();
    child.stdout?.on('data', (d) => { try { outStream.write(d); } catch {} });
    child.stderr?.on('data', (d) => { try { errStream.write(d); } catch {} });
    child.on('error', (error) => { try { errStream.write('# spawn error: ' + (error?.message ?? error) + '\n'); } catch {} });
    const finish = (status, code) => {
      if (j.status !== 'running') return;
      j.status = status;
      j.exitCode = code ?? null;
      j.finishedAt = Date.now();
      j.runtimeSec = Math.round((j.finishedAt - j.startedAt) / 1000);
      const t = timers.get(id);
      if (t) { clearTimeout(t); timers.delete(id); }
      closeStreams(id);
      save();
      trimHistory(); save();
      log(`[agent-jobs] ${id} ${status} exit=${code ?? '?'} (${j.label || j.command.slice(0, 60)})`);
      appendActivity(`后台任务 ${id} ${status}：${(j.label || j.command).slice(0, 80)}`);
      if (onFinished && j.followupKey) {
        try { Promise.resolve(onFinished(publicJob(j))).catch((e) => log('onFinished 回调失败: ' + (e?.message ?? e))); } catch (e) { log('onFinished 回调失败: ' + (e?.message ?? e)); }
      }
    };
    child.on('close', (code) => finish(code === 0 ? 'done' : 'failed', code));
    const minutes = Math.max(1, Math.min(Number(j.timeoutMin) || defaultMaxMinutes, MAX_MINUTES_CAP));
    const timer = setTimeout(() => {
      if (j.status !== 'running') return;
      j.note = `超过 ${minutes} 分钟被超时终止`;
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      try { child.kill(); } catch {}
      finish('timeout', null);
    }, minutes * 60000);
    if (timer.unref) timer.unref();
    timers.set(id, timer);
    log(`[agent-jobs] ${id} 启动 pid=${child.pid}: ${j.command.slice(0, 120)}`);
    appendActivity(`后台任务 ${id} 启动：${j.command.slice(0, 100)}`);
    return { ok: true, job: publicJob(j) };
  }

  function requestApproval({ command, label, requestedBy, timeoutMin, followupKey }) {
    if (reg.pendingApprovals.length >= MAX_PENDING) return { ok: false, error: '待审批队列已满（20），先清理旧的' };
    const id = 'a' + now36() + '-' + randId();
    const entry = { id, approvalId: id, command: String(command), label: label ? String(label).slice(0, 60) : null, requestedBy: requestedBy || null, timeoutMin, followupKey: followupKey || requestedBy || null, createdAt: Date.now() };
    reg.pendingApprovals.push(entry);
    save();
    log(`[agent-jobs] 待审批 ${id}: ${String(command).slice(0, 100)}（来自 ${requestedBy}）`);
    appendActivity(`后台任务待审批 ${id}：${String(command).slice(0, 100)}`);
    if (onNeedApproval) { try { Promise.resolve(onNeedApproval(entry)).catch(() => {}); } catch {} }
    return { ok: true, needApproval: true, approvalId: id, notice: '命令不在白名单，已提交主人审批；通过后开始执行' };
  }

  function start({ command, label, requestedBy, timeoutMin, followupKey, force }) {
    if (!enabled()) return { ok: false, error: 'agentJobs 未启用（config.agentJobs.enabled）' };
    const cmd = String(command ?? '').trim();
    if (!cmd || cmd.length < 2) return { ok: false, error: 'command 不能为空' };
    if (cmd.length > 2000) return { ok: false, error: 'command 过长（>2000 字符）' };
    const danger = dangerous(cmd);
    if (danger) return { ok: false, error: `命令命中危险黑名单（${danger.slice(0, 40)}…），已拒绝` };
    const allowName = matchAllow(cmd);
    const hash = commandHash(cmd);
    const approvedBefore = Object.prototype.hasOwnProperty.call(reg.approvals, hash);
    if (!allowName && !approvedBefore && !force) {
      return requestApproval({ command: cmd, label, requestedBy, timeoutMin, followupKey: followupKey || requestedBy });
    }
    if (reg.jobs.filter((j) => j.status === 'running').length >= maxConcurrent) {
      return { ok: false, error: `并发任务已达上限（${maxConcurrent}），等一个结束再开` };
    }
    const j = {
      id: 'j' + now36() + '-' + randId(),
      label: label ? String(label).slice(0, 60) : null,
      command: cmd,
      status: 'awaiting',
      pid: null, startedAt: null, finishedAt: null, exitCode: null, runtimeSec: null,
      timeoutMin: Math.max(1, Math.min(Number(timeoutMin) || defaultMaxMinutes, MAX_MINUTES_CAP)),
      requestedBy: requestedBy || null,
      followupKey: followupKey || requestedBy || null,
      approved: !!allowName || approvedBefore || !!force,
      allowRule: allowName || (approvedBefore ? '已审批过' : null)
    };
    if (!allowName && !approvedBefore) {
      // force 直跑（主人私聊/管理端）也记入 approvals，下次同命令免审
      reg.approvals[hash] = { command: cmd.slice(0, 200), at: Date.now(), by: requestedBy || 'force' };
    }
    reg.jobs.push(j);
    save();
    const res = actuallyStart(j);
    if (!res.ok) return res;
    return { ok: true, job: res.job, approved: j.approved, allowRule: j.allowRule };
  }

  function approve(approvalId) {
    const idx = reg.pendingApprovals.findIndex((p) => p.id === String(approvalId));
    if (idx < 0) return { ok: false, error: `找不到待审批 ${approvalId}` };
    // Bug #7：start() 有并发上限检查，但这条审批路径原本直接 actuallyStart。
    // 待审批积压时连点「ok」会一口气起满，绕过 maxConcurrent。这里补齐，
    // 且命中上限时把 entry 放回队列（刚才 splice 出来了），否则审批请求被吞掉。
    if (reg.jobs.filter((j) => j.status === 'running').length >= maxConcurrent) {
      return { ok: false, error: `并发任务已达上限（${maxConcurrent}），等一个结束再审批` };
    }
    const entry = reg.pendingApprovals.splice(idx, 1)[0];
    const hash = commandHash(entry.command);
    reg.approvals[hash] = { command: entry.command.slice(0, 200), at: Date.now(), by: 'owner' };
    const j = {
      id: 'j' + now36() + '-' + randId(),
      label: entry.label, command: entry.command, status: 'awaiting',
      pid: null, startedAt: null, finishedAt: null, exitCode: null, runtimeSec: null,
      timeoutMin: entry.timeoutMin || defaultMaxMinutes,
      requestedBy: entry.requestedBy, followupKey: entry.followupKey || entry.requestedBy,
      approved: true, allowRule: '主人审批'
    };
    reg.jobs.push(j);
    save();
    const res = actuallyStart(j);
    return res.ok ? { ok: true, job: res.job } : res;
  }

  function reject(approvalId) {
    const idx = reg.pendingApprovals.findIndex((p) => p.id === String(approvalId));
    if (idx < 0) return { ok: false, error: `找不到待审批 ${approvalId}` };
    const entry = reg.pendingApprovals.splice(idx, 1)[0];
    save();
    log(`[agent-jobs] 审批 ${approvalId} 被拒绝：${entry.command.slice(0, 100)}`);
    return { ok: true, rejected: approvalId, requestedBy: entry.requestedBy, followupKey: entry.followupKey };
  }

  function status(id) {
    if (id == null || String(id).trim() === '') {
      return { ok: true, jobs: reg.jobs.slice(-40).map(publicJob), pendingApprovals: reg.pendingApprovals.map((p) => ({ id: p.id, command: p.command, label: p.label || null, requestedBy: p.requestedBy, createdAt: p.createdAt })) };
    }
    const j = reg.jobs.find((x) => x.id === String(id));
    if (!j) return { ok: false, error: `找不到任务 ${id}` };
    return { ok: true, job: publicJob(j) };
  }

  function output(id, { tailBytes }) {
    const j = reg.jobs.find((x) => x.id === String(id));
    if (!j) return { ok: false, error: `找不到任务 ${id}` };
    const maxBytes = Math.max(512, Math.min(Number(tailBytes) || 8192, 65536));
    const outTail = readTail(path.join(jobsDir, j.id + '.out.log'), maxBytes);
    const errTail = readTail(path.join(jobsDir, j.id + '.err.log'), Math.max(256, Math.floor(maxBytes / 4)));
    return { ok: true, job: publicJob(j), outTail, errTail };
  }

  function kill(id) {
    const j = reg.jobs.find((x) => x.id === String(id));
    if (!j) return { ok: false, error: `找不到任务 ${id}` };
    if (j.status !== 'running') return { ok: false, error: `任务 ${id} 状态是 ${j.status}，不用杀` };
    try { spawn('taskkill', ['/PID', String(j.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    try { process.kill(j.pid); } catch {}
    j.status = 'killed'; j.finishedAt = Date.now();
    if (j.startedAt) j.runtimeSec = Math.round((j.finishedAt - j.startedAt) / 1000);
    const t = timers.get(j.id); if (t) { clearTimeout(t); timers.delete(j.id); }
    // Bug #8：kill 后 child.on('close') 会进 finish，但 finish 开头
    // `if (j.status !== 'running') return` 直接挡掉 → 日志流永远不 end。
    // 手动终止这条路径必须自己收尾，否则句柄泄漏 + 日志尾部丢缓冲。
    closeStreams(j.id);
    save();
    log(`[agent-jobs] ${j.id} 被手动终止`);
    return { ok: true, job: publicJob(j) };
  }

  return { start, approve, reject, status, output, kill, _enabled: enabled, _reg: () => reg };
}

export default createAgentJobsModule;
