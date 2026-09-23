// 修：表达提取要用"刚处理过的那批消息"（黑话提取后窗口已被清空）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let t = fs.readFileSync(BRIDGE, 'utf8');
const subs = [
  ["  async function runExpressionExtraction(key) {\n    if (cfg.expressions?.enabled === false) return;\n    if (!dshReady || expressionBusy || socialV2.paused) return;\n    const messages = slangWindows.get(key) ?? [];",
   "  async function runExpressionExtraction(key, messagesArg) {\n    if (cfg.expressions?.enabled === false) return;\n    if (!dshReady || expressionBusy || socialV2.paused) return;\n    // 注意：黑话提取后会把 slangWindows 里的窗口清空，所以优先用调用方传入的快照\n    const messages = (Array.isArray(messagesArg) && messagesArg.length) ? messagesArg : (slangWindows.get(key) ?? []);"],
  ["      queueSlangTask(() => runExpressionExtraction(key)).catch(() => {});",
   "      try { queueSlangTask(() => runExpressionExtraction(key, messages)); } catch (e) { log('[expression] 排队失败: ' + (e?.message ?? e)); }"],
];
let n = 0;
for (const [a, b] of subs) {
  if (t.includes(a)) { t = t.replace(a, b); n++; console.log('✅ 修补:', a.slice(0, 40)); }
  else console.log('⚠️ 未匹配:', a.slice(0, 40));
}
fs.writeFileSync(BRIDGE, t);
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('替换', n, '处；syntax OK');
