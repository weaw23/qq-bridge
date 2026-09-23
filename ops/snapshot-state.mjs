// 一次性快照：面板 overview + social-v2 wake/proactive + 记忆库计数 + 表达库
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:\\qqbot\\qq-bridge';
const STATE = path.join(ROOT, 'state');
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const token = (() => { try { return fs.readFileSync(path.join(STATE, 'console-token'), 'utf8').trim(); } catch { return ''; } })();

const out = {};
try {
  const r = await fetch('http://127.0.0.1:3100/api/panel/overview?token=' + encodeURIComponent(token));
  out.overview = await r.json();
} catch (e) { out.overview = { error: String(e.message) }; }

const sv = readJson(path.join(STATE, 'social-v2.json'), {}) ?? {};
out.sessionCount = Object.keys(sv).length;
out.sessions = Object.entries(sv).map(([k, v]) => ({
  key: k,
  wakeMode: v?.wake?.mode ?? '-',
  triggers: v?.wake?.triggers ? Object.keys(v.wake.triggers).filter((t) => v.wake.triggers[t]) : [],
  prob: v?.wake?.triggers?.probability ?? null,
  keywords: v?.wake?.triggers?.keywords ?? [],
  sleepUntil: v?.wake?.sleepUntil ?? null,
  lastSeen: v?.lastSeen ?? v?.lastActivity ?? null,
  proactive: v?.proactive ?? null,
  unread: Array.isArray(v?.unread) ? v.unread.length : null,
  hasToken: Boolean(v?.token),
}));

out.expressions = (readJson(path.join(STATE, 'expressions.json'), {}) ?? {});
out.slangCounts = (() => {
  const s = readJson(path.join(STATE, 'slang.json'), {}) ?? {};
  const items = Array.isArray(s) ? s : (s.items ?? s.entries ?? []);
  const arr = Array.isArray(items) ? items : Object.values(items);
  return {
    total: arr.length,
    confirmed: arr.filter((x) => x?.status === 'confirmed').length,
    candidate: arr.filter((x) => x?.status === 'candidate').length,
  };
})();
out.memoryAgentSession = readJson(path.join(STATE, 'memory-agent.json'), {});
out.mode = readJson(path.join(STATE, 'mode.json'), {});
out.feedback = (readJson(path.join(STATE, 'feedback.json'), []) ?? []).slice?.(-5) ?? null;
out.autonomyState = readJson(path.join(STATE, 'autonomy.json'), {});
out.toolCalls = fs.existsSync(path.join(STATE, 'tool-calls.jsonl'))
  ? fs.readFileSync(path.join(STATE, 'tool-calls.jsonl'), 'utf8').trim().split('\n').slice(-15).map((l) => { try { const o = JSON.parse(l); return { t: o.ts ?? o.time, tool: o.tool ?? o.name, conv: o.convKey ?? o.key, ok: o.ok ?? o.success }; } catch { return { raw: l.slice(0, 120) }; } })
  : [];

console.log(JSON.stringify(out, null, 1));
