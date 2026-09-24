// PC 控制扩展能力回归测试
// 用法：node ops/test-pc-actions.mjs
//
// 安全边界：本测试**不会**往任何窗口打字、不会改剪贴板内容、不会最小化/关闭任何窗口。
// 原因很简单——跑测试时主人正在用这台电脑，那些动作会直接干扰他。
// 因此对「有副作用」的能力只测校验分支（非法输入必须在真的动手之前就被拦下），
// 唯一实际发出的按键是 F13：绝大多数键盘没有这个键、也没有程序绑定它，无可见效果，
// 但足以证明 Add-Type + keybd_event 整条通路是通的。
import * as pc from '../src/pc-actions.js';
import fs from 'node:fs';

// 同时落盘：验证「后台长任务」需要子进程真能活下来。而在 DSH 的沙箱 shell 里直接跑本脚本时，
// 派生的子进程会被 Job Object 立刻清掉，测出来全是假失败。所以真正的验证走 WMI 脱离式启动，
// 那种情况下 stdout 无处可去，只能写文件、事后再回来读。
const TEE_DIR = 'D:\\qqbot\\outbox\\pc-jobs';
const TEE_FILE = TEE_DIR + '\\test-run.log';
try { fs.mkdirSync(TEE_DIR, { recursive: true }); fs.writeFileSync(TEE_FILE, ''); } catch {}
const rawLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  rawLog(line);
  try { fs.appendFileSync(TEE_FILE, line + '\n'); } catch {}
};

let failures = 0;
function check(name, pass, note = '') {
  console.log(`${pass ? '✅' : '❌'} ${name}${note ? '  ' + note : ''}`);
  if (!pass) failures++;
}
const has = (s, sub) => String(s ?? '').includes(sub);

// ── A) 输出扩容 + 溢出落盘 ───────────────────────────────────────────────────
console.log('=== A) runPS 输出扩容与溢出落盘 ===');
{
  const r = await pc.runPS('1..4000 | ForEach-Object { "line-$_-padding-padding-padding" }', 60000);
  check('超长命令执行成功', r.ok === true, r.ok ? '' : String(r.error).slice(0, 120));
  if (r.ok) {
    const len = r.output.length;
    check('输出被裁剪到上限附近（不再是一刀切 4000）', len > 5000 && len < 16000, `实得 ${len} 字符`);
    check('保留了头部', has(r.output, 'line-1-'), '');
    check('保留了尾部（异常栈常在末尾，只留头部会丢掉关键信息）', has(r.output, 'line-4000-'), '');
    check('标注了省略与落盘路径', has(r.output, '中间省略') && has(r.output, 'pc-jobs'), '');
    const m = /D:\\qqbot\\outbox\\pc-jobs\\output-\d+\.txt/.exec(r.output);
    if (m) {
      const full = fs.existsSync(m[0]) ? fs.readFileSync(m[0], 'utf8') : '';
      check('全文已落盘且完整', full.includes('line-1-') && full.includes('line-4000-'), `${full.length} 字符 @ ${m[0]}`);
    } else {
      check('全文已落盘且完整', false, '没从输出里解析出落盘路径');
    }
  }
}
{
  const r = await pc.runPS("Write-Output 'short'", 15000);
  check('短输出不受影响（原样返回、不落盘）', r.ok && r.output === 'short', `实得 "${r.output}"`);
}

// ── B) 窗口列举（只读）───────────────────────────────────────────────────────
console.log('\n=== B) listWindows（只读）===');
{
  const r = await pc.listWindows();
  check('能列出窗口', r.ok === true && has(r.output, 'pid='), r.ok ? String(r.output).split('\n')[0].slice(0, 80) : String(r.error).slice(0, 100));
}

// ── C) 组合键：只测校验分支 + 一个无副作用的 F13 ─────────────────────────────
console.log('\n=== C) sendKeys 校验与通路 ===');
{
  const r = await pc.sendKeys('');
  check('空 combo 被拦', r.ok === false && has(r.error, 'combo'), String(r.error).slice(0, 60));
}
{
  const r = await pc.sendKeys('nosuchkey');
  check('不认识的键被拦（且提示支持哪些）', r.ok === false && has(r.error, '不认识'), String(r.error).slice(0, 60));
}
{
  const r = await pc.sendKeys('ctrl+s+e');
  check('两个主键被拦', r.ok === false && has(r.error, '两个主键'), String(r.error).slice(0, 70));
}
{
  const r = await pc.sendKeys('f13');
  check('F13 实发成功（证明 Add-Type + keybd_event 通路可用）', r.ok === true, r.ok ? `combo=${r.combo}` : String(r.error).slice(0, 100));
}

// ── D) 打字：只测校验分支（不真打字，避免干扰主人当前窗口）───────────────────
console.log('\n=== D) typeText 校验（不实打）===');
{
  const r = await pc.typeText('');
  check('空文本被拦', r.ok === false && has(r.error, 'text'), String(r.error).slice(0, 60));
}
{
  const r = await pc.typeText('x'.repeat(5000));
  check('超长文本被拦（上限 4000）', r.ok === false && has(r.error, '4000'), String(r.error).slice(0, 70));
}
{
  // 转义逻辑单测：SendKeys 里 + ^ % ~ ( ) { } [ ] 都是特殊字符，必须逐个包进 {}，
  // 否则 "a+b" 会被理解成「按住 shift 打 a」而不是字面的加号。
  const esc = (t) => t.replace(/([+^%~(){}[\]])/g, '{$1}');
  const escIn = 'a+b^c%d~e(f){g}[h]';
  const escWant = 'a{+}b{^}c{%}d{~}e{(}f{)}{{}g{}}{[}h{]}';
  check('SendKeys 特殊字符转义正确', esc(escIn) === escWant, esc(escIn) === escWant ? '' : `期望 ${escWant}，实得 ${esc(escIn)}`);
  check('普通中英文不受转义影响', esc('你好abc123') === '你好abc123', esc('你好abc123'));
}

// ── E) 窗口操作：只测校验分支 ────────────────────────────────────────────────
console.log('\n=== E) windowAction 校验（不动真窗口）===');
{
  const r = await pc.windowAction('notepad', 'kill');
  check('非法 action 被拦', r.ok === false && has(r.error, 'action 仅支持'), String(r.error).slice(0, 70));
}
{
  const r = await pc.windowAction('', 'focus');
  check('空 target 被拦', r.ok === false && has(r.error, 'target'), String(r.error).slice(0, 60));
}
{
  const r = await pc.windowAction('zzz绝无此窗口zzz', 'minimize');
  check('找不到的窗口返回明确错误（而不是静默成功）', r.ok === false && has(r.error, '找不到窗口'), String(r.error ?? '').slice(0, 70));
}

// ── F) 剪贴板：只读 + 校验分支（不覆盖主人剪贴板）───────────────────────────
console.log('\n=== F) clipboard ===');
{
  const r = await pc.clipboard('get');
  check('能读剪贴板', r.ok === true, r.ok ? `（内容 ${String(r.output).length} 字符，出于隐私不打印）` : String(r.error).slice(0, 80));
  check('读取结果带隐私告警', r.ok === true && has(r.note, '敏感'), '');
}
{
  const r = await pc.clipboard('nope');
  check('非法 action 被拦', r.ok === false && has(r.error, 'get/set'), String(r.error).slice(0, 60));
}
{
  const r = await pc.clipboard('set', '');
  check('set 空文本被拦', r.ok === false && has(r.error, 'text'), String(r.error).slice(0, 60));
}
{
  const r = await pc.clipboard('set', 'y'.repeat(30000));
  check('set 超长被拦（上限 20000）', r.ok === false && has(r.error, '20000'), String(r.error).slice(0, 70));
}

// ── G) 后台长任务 ────────────────────────────────────────────────────────────
console.log('\n=== G) 后台长任务（startJob / jobStatus / jobKill / jobList）===');
{
  const r = await pc.startJob('');
  check('空命令被拦', r.ok === false && has(r.error, '命令'), String(r.error).slice(0, 60));
}
{
  const r = await pc.startJob('Start-Sleep -Seconds 2; Write-Output "job-finished-ok"', 5);
  check('任务已启动并返回 jobId', r.ok === true && !!r.jobId, r.ok ? `jobId=${r.jobId} pid=${r.pid}` : String(r.error).slice(0, 100));
  if (r.ok) {
    let st = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      st = await pc.jobStatus(r.jobId);
      if (st.status !== 'running') break;
    }
    check('任务结束后状态转为 finished', st?.status === 'finished', `实得 ${st?.status}（${st?.elapsedSec}s）`);
    check('能取到任务输出', has(st?.outputTail, 'job-finished-ok'), String(st?.outputTail ?? '').slice(0, 60));
    check('输出文件路径可用', !!st?.outFile && fs.existsSync(st.outFile), String(st?.outFile ?? ''));
  }
}
{
  // 增量落盘：长任务必须能「边跑边看到进度」，否则等于没有长任务能力
  const r = await pc.startJob('1..4 | ForEach-Object { Write-Output ("step-" + $_); Start-Sleep -Seconds 2 }', 5);
  if (r.ok) {
    await new Promise((res) => setTimeout(res, 5000));
    const mid = await pc.jobStatus(r.jobId);
    check('运行中就能 tail 到已产出的进度', mid.running === true && has(mid.outputTail, 'step-1'), `status=${mid.status} out=${JSON.stringify(String(mid.outputTail).slice(0, 40))}`);
    await pc.jobKill(r.jobId);
  } else {
    check('运行中就能 tail 到已产出的进度', false, String(r.error).slice(0, 100));
  }
}
{
  const r = await pc.startJob('Start-Sleep -Seconds 300; Write-Output "should-not-appear"', 5);
  if (r.ok) {
    await new Promise((res) => setTimeout(res, 2000));
    const before = await pc.jobStatus(r.jobId);
    check('长任务运行中状态为 running', before.running === true, `status=${before.status}`);
    const k = await pc.jobKill(r.jobId);
    check('能中止长任务', k.ok === true && k.status === 'killed', `status=${k.status}`);
    // 等 exit 事件把最终状态写盘：kill 只是发出信号，落盘是异步的
    let after = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 500));
      after = await pc.jobStatus(r.jobId);
      if (after.status !== 'running') break;
    }
    check('中止后进程确实没了', after?.running === false && after?.status === 'killed', `status=${after?.status}`);
    check('被杀的任务不会伪装成正常跑完', after?.status !== 'finished', `status=${after?.status}`);
  } else {
    check('长任务可被中止', false, String(r.error).slice(0, 100));
  }
}
{
  const r = await pc.jobStatus('no-such-job-id');
  check('查不存在的任务给出明确错误', r.ok === false && has(r.error, '找不到任务'), String(r.error).slice(0, 70));
}
{
  const r = await pc.jobList();
  check('能列出任务表（落盘、桥接重启后仍可查）', r.ok === true && r.count >= 1, `count=${r.count}`);
}

// ── H) 任务表落盘持久性 ──────────────────────────────────────────────────────
console.log('\n=== H) 任务表持久化 ===');
{
  const f = 'D:\\qqbot\\outbox\\pc-jobs\\jobs.json';
  const exists = fs.existsSync(f);
  check('jobs.json 已落盘', exists, exists ? `${fs.statSync(f).size} 字节` : '缺失');
  if (exists) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const first = Object.values(j)[0];
    check('落盘内容含 pid/命令原文/时限（事后可复查她跑了什么）',
      !!first && first.pid > 0 && typeof first.cmd === 'string' && first.maxMs > 0, '');
  }
}

// ── I) 桥接重启后的任务状态归属 ──────────────────────────────────────────────
console.log('\n=== I) 桥接重启后的任务归属 ===');
{
  const f = 'D:\\qqbot\\outbox\\pc-jobs\\jobs.json';
  const jobs = JSON.parse(fs.readFileSync(f, 'utf8'));
  // 借一个已经退出的真实 pid，避免猜一个不存在的号码
  const deadPid = Object.values(jobs).find((j) => j.status === 'finished')?.pid ?? 999999;
  const mk = (id, pid) => {
    jobs[id] = {
      pid, bridgePid: 1, cmd: 'orphan-test',
      outFile: 'D:\\qqbot\\outbox\\pc-jobs\\nope.out', errFile: 'D:\\qqbot\\outbox\\pc-jobs\\nope.err',
      startedAt: Date.now() - 60000, maxMs: 600000, status: 'running', exitCode: null
    };
    fs.writeFileSync(f, JSON.stringify(jobs, null, 2), 'utf8');
  };
  // I1：进程已死的孤儿任务 → 如实报 interrupted
  mk('fake-dead-orphan', deadPid);
  const st = await pc.jobStatus('fake-dead-orphan');
  check('上一代桥接留下的任务如实报 interrupted（不假装跑完）', st.status === 'interrupted', `status=${st.status}`);
  check('interrupted 附带可操作的说明', has(st.note, '桥接重启'), String(st.note).slice(0, 60));
  const kd = await pc.jobKill('fake-dead-orphan');
  check('已退出的孤儿任务 kill 时如实说明，不改写成 killed', kd.ok === true && has(kd.note, '本来就已经退出'), String(kd.note ?? kd.error).slice(0, 60));
  // I2：pid 还活着、但不是本进程启动的 → 必须拒绝盲杀。
  // 故意拿测试进程自己的 pid 当靶子：万一守卫失效，死的是这个测试而不是别的程序。
  mk('fake-live-foreign', process.pid);
  const kl = await pc.jobKill('fake-live-foreign');
  check('拒绝盲杀不是自己启动的活进程（pid 可能已被系统复用）', kl.ok === false && has(kl.error, '拒绝盲杀'), String(kl.error ?? kl.status).slice(0, 70));
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete after['fake-dead-orphan'];
  delete after['fake-live-foreign'];
  fs.writeFileSync(f, JSON.stringify(after, null, 2), 'utf8');
}

console.log(`\n===== ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} =====`);
process.exit(failures === 0 ? 0 : 1);
