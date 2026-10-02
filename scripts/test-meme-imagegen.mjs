// 鲸鲸 3.0 P2 单元测试：meme 客户端闸门 + imagegen 配额/落盘（离线，不打真实 API）
// 运行：node scripts/test-meme-imagegen.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemeModule, avatarUrlOf } from '../src/meme.js';
import { createImageGenModule } from '../src/imagegen.js';

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p2-')));
const noop = () => {};

// ── meme 模块 ────────────────────────────────────────────────────────────
await t('meme.enabled 默认开 / 显式关', () => {
  const mk = (v) => createMemeModule({ cfg: { meme: v }, log: noop, appendActivity: noop }).enabled();
  assert.equal(mk(undefined), true);
  assert.equal(mk({ enabled: false }), false);
  assert.equal(mk({ enabled: true }), true);
});

await t('avatarUrlOf 生成 qlogo 直链', () => {
  assert.equal(avatarUrlOf(1918594889), 'https://q1.qlogo.cn/g?b=qq&nk=1918594889&s=640');
  assert.equal(avatarUrlOf('3692140164'), 'https://q1.qlogo.cn/g?b=qq&nk=3692140164&s=640');
});

await t('makeMeme 图片源校验：非法源报错', async () => {
  const meme = createMemeModule({ cfg: { meme: { enabled: true } }, log: noop, appendActivity: noop });
  await assert.rejects(() => meme.makeMeme({ key: 'petpet', imageSources: ['file:///C:/evil'] }), /图片源仅支持/);
  await assert.rejects(() => meme.makeMeme({ key: 'petpet', imageSources: [''] }), /图片源为空/);
  await assert.rejects(() => meme.makeMeme({ key: '' }), /key 为空/);
});

await t('makeMeme 未启用时报错', async () => {
  const meme = createMemeModule({ cfg: { meme: { enabled: false } }, log: noop, appendActivity: noop });
  await assert.rejects(() => meme.makeMeme({ key: 'petpet' }), /未开启/);
});

// ── imagegen 模块 ────────────────────────────────────────────────────────
await t('imagegen.enabled 需 apiKey', () => {
  const mk = (v) => createImageGenModule({ cfg: { imagegen: v }, log: noop, appendActivity: noop }).enabled();
  assert.equal(mk(undefined), false, '无配置=关（缺 key）');
  assert.equal(mk({ apiKey: 'x' }), true);
  assert.equal(mk({ enabled: false, apiKey: 'x' }), false);
});

await t('imagegen 配额：跨天清零 / 超额拒绝 / 递减', async () => {
  const dir = tmp();
  const ig = createImageGenModule({
    cfg: { imagegen: { apiKey: 'k', maxPerDay: 2, outboxDir: dir, stateDir: path.join(dir, 'st') } },
    log: noop, appendActivity: noop
  });
  assert.equal(ig.quotaRemaining(), 2, '初始 2');
  // 手工造一份"今天已用 2"的配额文件
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  fs.mkdirSync(path.join(dir, 'st'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'st', 'imagegen-quota.json'), JSON.stringify({ date: todayStr, count: 2 }));
  assert.equal(ig.quotaRemaining(), 0, '当天已用 2 → 0');
  await assert.rejects(() => ig.generate('画只鲸鱼'), /配额不足/);
  // 昨天的旧记录不影响今天
  fs.writeFileSync(path.join(dir, 'st', 'imagegen-quota.json'), JSON.stringify({ date: '2000-01-01', count: 99 }));
  assert.equal(ig.quotaRemaining(), 2, '旧日期 → 清零重来');
});

await t('imagegen generate：mock API 成功 → 落盘 + 计数', async () => {
  const dir = tmp();
  const realFetch = globalThis.fetch;
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(200, 7)]);
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /v1\/images\/generations$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'gpt-image-2-low');
    assert.equal(body.n, 1);
    return { ok: true, json: async () => ({ data: [{ b64_json: fakePng.toString('base64') }] }) };
  };
  try {
    const ig = createImageGenModule({
      cfg: { imagegen: { apiKey: 'k', maxPerDay: 5, outboxDir: dir, stateDir: path.join(dir, 'st') } },
      log: noop, appendActivity: noop
    });
    const r = await ig.generate('画一只鲸鲸在泡澡', { n: 1 });
    assert.equal(r.images.length, 1);
    assert.ok(fs.existsSync(r.images[0].file.replace('file:///', '')));
    assert.equal(r.remaining, 4, '用掉 1 剩 4');
    assert.equal(ig.quotaRemaining(), 4);
  } finally { globalThis.fetch = realFetch; }
});

await t('imagegen generate：API 失败 → 报错且不扣配额', async () => {
  const dir = tmp();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  try {
    const ig = createImageGenModule({
      cfg: { imagegen: { apiKey: 'k', maxPerDay: 5, outboxDir: dir, stateDir: path.join(dir, 'st') } },
      log: noop, appendActivity: noop
    });
    await assert.rejects(() => ig.generate('x'), /HTTP 429/);
    assert.equal(ig.quotaRemaining(), 5, '失败不扣');
  } finally { globalThis.fetch = realFetch; }
});

await t('imagegen generate：prompt 闸门', async () => {
  const ig = createImageGenModule({ cfg: { imagegen: { apiKey: 'k' } }, log: noop, appendActivity: noop });
  await assert.rejects(() => ig.generate('   '), /为空/);
  await assert.rejects(() => ig.generate('x'.repeat(2001)), /过长/);
});

console.log(`PASS ${passed} 组`);
