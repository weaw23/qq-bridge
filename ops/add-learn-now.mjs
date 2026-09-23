// 加"立即学一次"接口（播种学习窗口 → 跑黑话+表达提取）+ 面板按钮
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const BRIDGE = 'D:/qqbot/qq-bridge/src/bridge.js';
let b = fs.readFileSync(BRIDGE, 'utf8');
if (b.includes('style/extract-now')) throw new Error('已有该接口');

const anchor = "        // ── 控制台面板 API（集中开关 + 一键控制） ────────────────────────";
const i = b.indexOf(anchor);
if (i === -1) throw new Error('找不到面板 API 锚点');
const lineStart = b.lastIndexOf('\n', i) + 1;

const ep = `        // ── 立即学一次（用桥接侧历史消息播种学习窗口，跑黑话+表达提取） ──
        if (req.method === 'POST' && url.pathname === '/api/panel/style/extract-now') {
          const body = await readBody();
          const onlyKey = String(body.key ?? '').trim();
          const keys = onlyKey ? [onlyKey] : Object.keys(state.sessions ?? {});
          const seeded = [];
          for (const k of keys) {
            const st = getSocialV2State(k);
            const msgs = (st?.recentMessages ?? []).filter((m) => !m.isSelf && String(m.text ?? '').trim().length >= 2).slice(-30);
            if (msgs.length >= 8) { slangWindows.set(k, msgs); seeded.push(k + '(' + msgs.length + ')'); }
          }
          if (!seeded.length) { sendJson({ ok: false, error: '没有足够的历史消息可学（每个会话至少 8 条）' }, 400); return; }
          sendJson({ ok: true, seeded, note: '已开始学习：' + seeded.join('、') });
          setTimeout(() => {
            for (const k of keys) {
              queueSlangTask(async () => {
                try { await runSlangExtraction(k); } catch (e) { log('[learn] 黑话失败 ' + k + ': ' + (e?.message ?? e)); }
                try { await runExpressionExtraction(k); } catch (e) { log('[learn] 表达失败 ' + k + ': ' + (e?.message ?? e)); }
              }).catch(() => {});
            }
          }, 500);
          return;
        }

`;
b = b.slice(0, lineStart) + ep + b.slice(lineStart);
fs.writeFileSync(BRIDGE, b);
execFileSync('node', ['--check', BRIDGE], { stdio: 'inherit' });
console.log('✅ 接口已加，syntax OK');

// 面板按钮
const PANEL = 'D:/qqbot/qq-bridge/console-panel.html';
let p = fs.readFileSync(PANEL, 'utf8');
if (!p.includes('style/extract-now')) {
  p = p.replace(
    '<button onclick="act(\'sync-stickers\')">同步收藏表情</button>',
    '<button onclick="act(\'sync-stickers\')">同步收藏表情</button>\n      <button onclick="learnNow()">立即学一次（黑话+表达）</button>'
  );
  p = p.replace(
    "async function resetAllSessions() {",
    "async function learnNow() {\n  try { const r = await api('/api/panel/style/extract-now', { method: 'POST', body: JSON.stringify({}) }); toast(r.note || '已开始学习'); setTimeout(() => showTab('expressions'), 20000); }\n  catch (e) { toast('失败：' + e.message, true); }\n}\nasync function resetAllSessions() {"
  );
  fs.writeFileSync(PANEL, p);
  console.log('✅ 面板按钮已加');
}
