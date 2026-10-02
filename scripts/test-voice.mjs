// 鲸鲸 3.0 P1：src/voice.js 单元测试（silk 编解码往返 / wav 头 / base64 下载 / 闸门）
// 运行：node scripts/test-voice.mjs（离线，不依赖 GPT-SoVITS / whisper）
import assert from 'node:assert';
import { createVoiceModule, downloadRecordBuffer, wavFromPcm16, isSilk, silkEncode, silkDecode, getDuration } from '../src/voice.js';

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

// ── 1. wavFromPcm16：44 字节 RIFF 头 ─────────────────────────────────────
await t('wavFromPcm16 写出标准 44 字节 WAV 头', () => {
  const pcm = new Int16Array(1600); // 0.1s @16k 静音
  const wav = wavFromPcm16(pcm, 16000);
  assert.equal(wav.length, 44 + 3200);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);        // PCM
  assert.equal(wav.readUInt16LE(22), 1);        // 单声道
  assert.equal(wav.readUInt32LE(24), 16000);    // 采样率
  assert.equal(wav.readUInt16LE(34), 16);       // 位深
  assert.equal(wav.readUInt32LE(40), 3200);     // data 长度
});

// ── 2. silk 编解码往返 ──────────────────────────────────────────────────
await t('silkEncode→isSilk→silkDecode 往返（0.5s 正弦波）', async () => {
  const SR = 16000;
  const n = Math.floor(SR * 0.5);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * (i / SR)) * 12000);
  const wav = wavFromPcm16(pcm, SR);
  const { data: silk, duration } = await silkEncode(wav, 0);
  assert.ok(silk.length > 50, 'silk 应有内容'); // silk-wasm 返回 Uint8Array（voice.js 里会 Buffer.from）
  assert.ok(isSilk(silk), 'isSilk 应识别编码结果');
  assert.ok(Math.abs(duration - 500) < 150, `时长约 500ms（实测 ${duration}，单位=毫秒）`);
  const decoded = await silkDecode(silk, 24000); // 用不同采样率解码（模拟入向 24k）
  // decoded.data 是 s16le 字节流（不是样本数组）：字节数 = 2 × 样本数
  assert.equal(decoded.data.length % 2, 0, '解码字节流长度应为偶数');
  assert.ok(decoded.data.length >= 2 * SR * 0.3 * (24000 / SR) * 0.8, '解码 pcm 有内容');
  assert.ok(Math.abs(decoded.duration - 500) < 150, `decoded.duration 约 500ms（实测 ${decoded.duration}，单位=毫秒）`);
  const durMs = await getDuration(silk);
  assert.ok(Math.abs(durMs - 500) < 150, `getDuration 约 500ms（实测 ${durMs}，单位=毫秒）`);
  // 字节流 → wavFromPcm16 → 有效 wav（入向 ASR 真实路径）
  const wav2 = wavFromPcm16(decoded.data, 24000);
  assert.equal(wav2.length % 2, 0);
  assert.equal(wav2.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav2.readUInt32LE(24), 24000);
  assert.equal(wav2.readUInt32LE(40), decoded.data.length, 'data 块长度=字节流长度');
  const samples = new Int16Array(wav2.buffer, wav2.byteOffset + 44, decoded.data.length / 2);
  let mx = 0; for (let i = 0; i < samples.length; i++) mx = Math.max(mx, Math.abs(samples[i]));
  assert.ok(mx > 3000, `解码样本应有正弦波幅度（实测峰值 ${mx}）`);
});

// ── 3. downloadRecordBuffer：base64:// 协议 ─────────────────────────────
await t('downloadRecordBuffer 解析 base64://', async () => {
  const buf = await downloadRecordBuffer('base64://' + Buffer.from('hello-silk').toString('base64'));
  assert.equal(buf.toString(), 'hello-silk');
});

// ── 4. 非 silk 输入（amr 旧格式）→ format 占位 ──────────────────────────
await t('transcribeRecord 对 amr 返回 reason=format', async () => {
  const noop = () => {};
  const voice = createVoiceModule({ cfg: { voice: { enabled: true } }, log: noop, appendActivity: noop });
  const amr = Buffer.concat([Buffer.from('#!AMR'), Buffer.alloc(200, 7)]);
  const r = await voice.transcribeRecord(amr);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'format');
});

// ── 5. 闸门与配置默认值 ─────────────────────────────────────────────────
await t('voice.enabled() 默认开启 / 显式关闭', () => {
  const mk = (v) => { const voice = createVoiceModule({ cfg: { voice: v }, log: () => {}, appendActivity: () => {} }); return voice.enabled(); };
  assert.equal(mk(undefined), true, '无 voice 配置时默认开启');
  assert.equal(mk({ enabled: false }), false, 'enabled=false 关闭');
  assert.equal(mk({ enabled: true }), true);
});

await t('synthesize 文本长度闸门（maxChars）', async () => {
  const voice = createVoiceModule({ cfg: { voice: { enabled: true, maxChars: 10 } }, log: () => {}, appendActivity: () => {} });
  await assert.rejects(() => voice.synthesize('一'.repeat(11)), /过长/);
  await assert.rejects(() => voice.synthesize('   '), /为空/);
});

console.log(`PASS ${passed} 组`);
