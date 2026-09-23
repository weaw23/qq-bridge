// P6-5 桥接接线：表达库（提取 → 学习会话 → 注入）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let t = fs.readFileSync(BRIDGE, 'utf8');
if (t.includes('runExpressionExtraction')) throw new Error('已接线');

// 1) import
const impFrom = "import { buildSummaryPrompt, parseSummaryJson, toBigrams, queryToMatch, formatProfileLine } from './memory-engine.js';";
if (!t.includes(impFrom)) throw new Error('找不到 memory-engine import');
t = t.replace(impFrom, impFrom + "\nimport {\n  loadExpressionStore,\n  saveExpressionStore,\n  upsertExpression,\n  buildExpressionContext,\n  buildExpressionPrompt,\n  parseExpressionJson\n} from './expression-learner.js';");

// 2) 状态变量 + 提取/注入函数（插在记忆引擎核心之前）
const anchor = '  // ── P6：记忆引擎（自动摘要 → 长期记忆/人物画像/待跟进）+ 自主性调度（复盘/关心） ──';
const ai = t.indexOf(anchor);
if (ai === -1) throw new Error('找不到 P6 核心锚点');
const lineStart = t.lastIndexOf('\n', ai) + 1;
const core = `  // ── P6-5：表达学习（句式/语气模板库，借鉴 MaiBot 的表达学习思路） ──
  const EXPRESSION_FILE = path.join(STATE_DIR, 'expressions.json');
  let expressionEntries = loadExpressionStore(EXPRESSION_FILE);
  let expressionBusy = false;

  async function runExpressionExtraction(key) {
    if (cfg.expressions?.enabled === false) return;
    if (!dshReady || expressionBusy || socialV2.paused) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(3, Number(cfg.expressions?.minMessages) || 8);
    if (messages.length < min) return;
    expressionBusy = true;
    try {
      const sessionId = await ensureSlangLearnerSession();
      const promptText = buildExpressionPrompt(messages);
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (accepted?.result && accepted.result.ok === false) { log('[expression] 提取被拒'); return; }
      const output = await waitLearnerTurn(sessionId, Number(cfg.expressions?.timeoutMs) || 180000);
      const items = parseExpressionJson(output);
      if (!items.length) { log('[expression] ' + key + ' 本轮没有发现新句式'); return; }
      let added = 0, updated = 0;
      for (const it of items) {
        const idx = Number(it.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: String(src.text ?? '').slice(0, 80), time: src.time }] : [];
        const r = upsertExpression(expressionEntries, it.pattern, { usage: it.usage, tone: it.tone, example: it.example || src?.text || '', evidence });
        if (r.created) added++; else updated++;
      }
      saveExpressionStore(EXPRESSION_FILE, expressionEntries);
      log('[expression] ' + key + ' 句式库：新增 ' + added + '，更新 ' + updated + '（共 ' + expressionEntries.length + '）');
    } catch (error) {
      log('[expression] 提取失败 ' + key + ': ' + (error?.message ?? error));
    } finally {
      expressionBusy = false;
    }
  }

  function withExpressionContext(promptText) {
    try {
      if (cfg.expressions?.enabled === false) return promptText;
      const block = buildExpressionContext(expressionEntries, Number(cfg.expressions?.injectMax) || 8);
      if (!block) return promptText;
      return block + '\\n\\n' + promptText;
    } catch { return promptText; }
  }

`;
t = t.slice(0, lineStart) + core + t.slice(lineStart);

// 3) 注入：withSlangContext 的返回处追加表达库
const fromRet = `    return parts.join('\\n\\n') + '\\n\\n' + promptText;
  }`;
const toRet = `    const joined = parts.join('\\n\\n') + '\\n\\n' + promptText;
    return withExpressionContext(joined);
  }`;
if (t.includes(fromRet)) { t = t.replace(fromRet, toRet); console.log('  ✅ withSlangContext 注入表达库'); }
else console.log('  ⚠️ 未找到 withSlangContext 返回处');

// 4) 黑话提取之后顺带跑一次表达提取
const fromSlangEnd = `      log(\`黑话提取：\${key} 新增 \${added} 条，更新 \${updated} 条\`);`;
if (t.includes(fromSlangEnd)) {
  t = t.replace(fromSlangEnd, fromSlangEnd + `\n      // P6-5：同一批语料顺带学一次"说话方式"（复用学习会话，不额外开窗口）\n      queueSlangTask(() => runExpressionExtraction(key)).catch(() => {});`);
  console.log('  ✅ 黑话提取后接表达提取');
} else console.log('  ⚠️ 未找到黑话提取日志锚点');

fs.writeFileSync(BRIDGE, t);
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ bridge syntax OK');
