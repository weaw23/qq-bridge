// 鲸鲸 3.0 P2：AI 画图（gemai.cc，OpenAI 兼容 /v1/images/generations）。
//   每日配额（默认 20 张/天）落盘 state/imagegen-quota.json；产物存 outbox 供发送。
//   计费 API：默认走低档模型（gpt-image-2-low），config.json imagegen 段可改。
import fs from 'node:fs';
import path from 'node:path';

const GEN_TIMEOUT_MS = 180000;

export function createImageGenModule({ cfg, log, appendActivity }) {
  const ic = () => cfg.imagegen ?? {};
  const enabled = () => ic().enabled !== false && !!ic().apiKey;
  const outboxDir = () => String(ic().outboxDir || 'D:/qqbot/outbox');
  const stateDir = () => String(ic().stateDir || 'D:/qqbot/qq-bridge/state');
  const quotaFile = () => path.join(stateDir(), 'imagegen-quota.json');
  const maxPerDay = () => Math.max(0, Number(ic().maxPerDay ?? 20));

  function readQuota() {
    try {
      const j = JSON.parse(fs.readFileSync(quotaFile(), 'utf8'));
      if (j && typeof j === 'object') return j;
    } catch {}
    return { date: '', count: 0 };
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function quotaRemaining() {
    const q = readQuota();
    const today = todayStr();
    const count = q.date === today ? Number(q.count || 0) : 0;
    return Math.max(0, maxPerDay() - count);
  }

  function bumpQuota(n) {
    const today = todayStr();
    const q = readQuota();
    const count = (q.date === today ? Number(q.count || 0) : 0) + n;
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(quotaFile(), JSON.stringify({ date: today, count }));
    return maxPerDay() - count;
  }

  // prompt → { images:[{file, size}], remaining, model }
  async function generate(prompt, { n = 1 } = {}) {
    if (!enabled()) throw new Error('画图功能未开启或未配置 apiKey（config.json imagegen）');
    const clean = String(prompt ?? '').trim();
    if (!clean) throw new Error('画图 prompt 为空');
    if (clean.length > 2000) throw new Error('画图 prompt 过长（>2000 字符）');
    const count = Math.min(3, Math.max(1, Number(n) || 1));
    if (quotaRemaining() < count) {
      throw new Error(`今日画图配额不足（剩 ${quotaRemaining()} 张 / 上限 ${maxPerDay()}，明天再画，或让主人改 config.json imagegen.maxPerDay）`);
    }
    const v = ic();
    const body = {
      model: String(v.model || 'gpt-image-2-low'),
      prompt: clean,
      n: count,
      ...v.extra || {}
    };
    const res = await fetch(String(v.url || 'https://api3.gemai.cc').replace(/\/+$/, '') + '/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + v.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(v.timeoutMs ?? GEN_TIMEOUT_MS))
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch {}
      throw new Error(`画图 API 失败 HTTP ${res.status}${detail ? '：' + detail : ''}`);
    }
    const j = await res.json().catch(() => { throw new Error('画图 API 返回非 JSON'); });
    const items = Array.isArray(j?.data) ? j.data : [];
    if (!items.length) throw new Error('画图 API 没有返回图片（' + JSON.stringify(j).slice(0, 200) + '）');
    const images = [];
    fs.mkdirSync(outboxDir(), { recursive: true });
    for (let i = 0; i < items.length; i++) {
      const b64 = items[i]?.b64_json;
      if (!b64) continue;
      const bytes = Buffer.from(String(b64), 'base64');
      if (bytes.length < 100) continue;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const file = path.join(outboxDir(), 'gen-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + (isPng ? '.png' : '.jpg'));
      fs.writeFileSync(file, bytes);
      images.push({ file: 'file:///' + file.replace(/\\/g, '/'), size: bytes.length });
    }
    if (!images.length) throw new Error('画图返回里没有可用的 b64_json 数据');
    const remaining = bumpQuota(images.length);
    appendActivity?.('AI 画图：' + clean.slice(0, 40) + (images.length > 1 ? ' 等 ' + images.length + ' 张' : ''));
    log('[imagegen] 生成 ' + images.length + ' 张（prompt=' + clean.slice(0, 60) + '，剩余配额 ' + remaining + '）');
    return { images, remaining, model: body.model };
  }

  return { enabled, generate, quotaRemaining, _resetQuota: () => { try { fs.rmSync(quotaFile()); } catch {} } };
}
