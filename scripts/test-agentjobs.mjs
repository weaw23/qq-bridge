// test-agentjobs.mjs — 鲸鲸 3.0 P3 离线单测：白名单/黑名单/审批流/生命周期/输出读取
// 运行：node scripts/test-agentjobs.mjs（在 qq-bridge 目录下）
import { createAgentJobsModule } from '../src/agentjobs.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshModule(tweak, hooks) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ajobs-'));
  const cfg = {
    _configPath: path.join(tmp, 'config.json'),
    agentJobs: {
      enabled: true, cwd: tmp, maxConcurrent: 2, maxMinutes: 1,
      allow: [
        { name: 'node 脚本', match: '^node(\\.exe)?\\s+(-[A-Za-z]+\\s+)*[A-Za-z0-9_:\\\\/\\.-]+\\.(mjs|js)\\b' },
        { name: 'node -e 内联', match: '^node(\\.exe)?\\s+-e\\s' },
        { name: 'echo 演示', match: '^echo\\s' }
      ],
      ...(tweak || {})
    }
  };
  fs.writeFileSync(cfg._configPath, '{}');
  const logs = [];
  const mod = createAgentJobsModule({
    cfg,
    log: (m) => logs.push(String(m)),
    appendActivity: () => {},
    ...(hooks || {})
  });
  return { mod, tmp, logs };
}

// ── 1. 闸门：enabled=false 拒绝 ───────────────────────────────────────
{
  const { mod } = freshModule({ enabled: false });
  const r = mod.start({ command: 'echo hi', requestedBy: 'private:1918594889' });
  ok(r.ok === false && /未启用/.test(r.error), 'enabled=false 时拒绝启动');
}

// ── 2. 危险命令黑名单（即使白名单命中也拒） ───────────────────────────
{
  const { mod } = freshModule();
  for (const cmd of ['format D:', 'shutdown /s', 'reg add HKLM\\x', 'Remove-Item C:\\Windows -Recurse -Force', 'taskkill /f /im explorer']) {
    const r = mod.start({ command: cmd, requestedBy: 'private:1918594889' });
    ok(r.ok === false && /黑名单/.test(r.error), '危险命令拦截：' + cmd.slice(0, 30));
  }
}

// ── 3. 空命令 / 白名单命中直跑 ───────────────────────────────────────
{
  const { mod } = freshModule();
  const rEmpty = mod.start({ command: '  ', requestedBy: 'private:1918594889' });
  ok(rEmpty.ok === false && /不能为空/.test(rEmpty.error), '空命令拒绝');
  const r = mod.start({ command: 'echo hello-jobs', label: '测试回声', requestedBy: 'private:1918594889' });
  ok(r.ok === true && r.job && r.job.status === 'running', '白名单命令直接启动', JSON.stringify(r));
  await sleep(2500);
  const st = mod.status(r.job.id);
  ok(st.ok && (st.job.status === 'done' || st.job.status === 'failed'), 'echo 任务 2.5s 内结束', JSON.stringify(st.job));
  ok(st.job.status === 'done' && st.job.exitCode === 0, 'echo 退出码 0', 'status=' + st.job.status + ' exit=' + st.job.exitCode);
  const out = mod.output(r.job.id, {});
  ok(out.ok && /hello-jobs/.test(out.outTail || ''), '输出日志含回声内容', (out.outTail || '').slice(0, 80));
}

// ── 4. 非白名单 → 待审批 → 批准后运行；approve 幂等校验 ────────────────
{
  let notified = null, finished = null;
  const { mod } = freshModule({}, {
    onNeedApproval: (e) => { notified = e; },
    onFinished: (j) => { finished = j; }
  });
  const r = mod.start({ command: 'powershell Write-Output APPROVED-RUN', requestedBy: 'group:471975044', followupKey: 'group:471975044' });
  ok(r.ok === true && r.needApproval === true && r.approvalId, '非白名单转待审批', JSON.stringify(r));
  ok(notified && notified.id === r.approvalId, 'onNeedApproval 通知主人');
  const st = mod.status();
  ok(st.pendingApprovals.length === 1 && st.pendingApprovals[0].id === r.approvalId, '待审批队列可查');
  const bad = mod.approve('nope');
  ok(bad.ok === false, '批准不存在的 id 报错');
  const ap = mod.approve(r.approvalId);
  ok(ap.ok === true && ap.job.status === 'running', '批准后立即启动', JSON.stringify(ap));
  await sleep(2500);
  const st2 = mod.status(ap.job.id);
  ok(st2.ok && st2.job.status === 'done' && st2.job.exitCode === 0, '已批准任务跑完', 'status=' + st2.job?.status);
  const out = mod.output(ap.job.id, {});
  ok(/APPROVED-RUN/.test(out.outTail || ''), '已批准任务输出正确');
  ok(finished && finished.id === ap.job.id && finished.followupKey === 'group:471975044', 'onFinished 携带 followupKey');
  // 同命令二次提交：已在 approvals，直接跑（不转审批）
  const r2 = mod.start({ command: 'powershell Write-Output APPROVED-RUN', requestedBy: 'group:471975044' });
  ok(r2.ok === true && !r2.needApproval && r2.approved === true, '审批过一次的命令免审直跑', JSON.stringify(r2));
}

// ── 5. kill 运行中任务 / 并发上限 ────────────────────────────────────
{
  const { mod } = freshModule();
  const r1 = mod.start({ command: 'node -e "setTimeout(()=>console.log(1), 60000)"', requestedBy: 'private:1918594889' });
  const r2 = mod.start({ command: 'node -e "setTimeout(()=>console.log(2), 60000)"', requestedBy: 'private:1918594889' });
  ok(r1.ok && r2.ok, '两个任务启动');
  const r3 = mod.start({ command: 'node -e "setTimeout(()=>console.log(3), 60000)"', requestedBy: 'private:1918594889' });
  ok(r3.ok === false && /并发|上限/.test(r3.error), '第三个任务被并发上限挡住', JSON.stringify(r3));
  const k = mod.kill(r1.job.id);
  ok(k.ok === true && k.job.status === 'killed', 'kill 置 killed', JSON.stringify(k));
  const k2 = mod.kill(r1.job.id);
  ok(k2.ok === false, '重复 kill 报错');
  const k3 = mod.kill('j-nope');
  ok(k3.ok === false, 'kill 不存在的 id 报错');
  mod.kill(r2.job.id);
  await sleep(1500);
}

// ── 6. 超时终止（maxMinutes=1 但 timeoutMin 传 1 → 用 setTimeout 快进不了，改小逻辑验证入口） ──
{
  // timeoutMin 最小 1 分钟：不真等 1 分钟，只验证字段被记录 + 定时器挂上
  const { mod } = freshModule();
  const r = mod.start({ command: 'node -e "setTimeout(()=>console.log(\'long\'), 120000)"', requestedBy: 'private:1918594889', timeoutMin: 1 });
  ok(r.ok && r.job.timeoutMin === 1, 'timeoutMin 传入并记录', JSON.stringify(r.job));
  mod.kill(r.job.id);
}

// ── 7. 注册表持久化：重建模块后历史还在 ─────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ajobs-p-'));
  const cfg = { _configPath: path.join(tmp, 'config.json'), agentJobs: { enabled: true, cwd: tmp, allow: [{ name: 'echo', match: '^echo\\s' }] } };
  fs.writeFileSync(cfg._configPath, '{}');
  const m1 = createAgentJobsModule({ cfg, log: () => {}, appendActivity: () => {} });
  const r = m1.start({ command: 'echo persist-me', requestedBy: 'private:1918594889' });
  ok(r.ok, '第一实例启动');
  await sleep(2000);
  const m2 = createAgentJobsModule({ cfg, log: () => {}, appendActivity: () => {} });
  const st = m2.status(r.job.id);
  ok(st.ok && st.job.id === r.job.id && st.job.status !== 'running', '第二实例读到历史（持久化 OK）', JSON.stringify(st.job));
  ok(/persist-me/.test(m2.output(r.job.id, {}).outTail || ''), '第二实例能读输出日志');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
