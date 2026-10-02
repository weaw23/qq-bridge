// 鲸鲸 3.0 语音之外的 P2 模块：表情包（meme-generator）客户端。
//   本地 meme-server（D:\ai-tools\meme-server.py, :9882, watchdog 常驻）提供能力；
//   桥这边只做：HTTP 调用、头像/图片源解析、产物落盘 outbox（供 file:///D:/qqbot/outbox/ 发送）。
// 出错全部抛 Error（端点层转 JSON 错误）；meme 服务挂了有 5 分钟熔断（避免每次工具调用都等超时）。
import fs from 'node:fs';
import path from 'node:path';
import { downloadRecordBuffer } from './voice.js';

const MEME_TIMEOUT_MS = 60000;
const MEME_BREAK_MS = 5 * 60 * 1000;

export function avatarUrlOf(qq) {
  return 'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(String(qq)) + '&s=640';
}

export function createMemeModule({ cfg, log, appendActivity }) {
  const memeCfg = () => cfg.meme ?? {};
  const enabled = () => memeCfg().enabled !== false;
  const serverUrl = () => String(memeCfg().serverUrl || 'http://127.0.0.1:9882').replace(/\/+$/, '');
  const outboxDir = () => String(memeCfg().outboxDir || 'D:/qqbot/outbox');
  let downUntil = 0;

  async function call(p, body, timeoutMs = MEME_TIMEOUT_MS) {
    if (Date.now() < downUntil) throw new Error('meme 服务暂不可用（熔断中，稍后再试）');
    try {
      const res = await fetch(serverUrl() + p, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error || ('meme HTTP ' + res.status));
      return j;
    } catch (error) {
      if (/timed? ?out|fetch failed|ECONNREFUSED|network|abort/i.test(String(error?.message ?? error))) {
        downUntil = Date.now() + MEME_BREAK_MS;
        log('[meme] 服务不可达（熔断 5 分钟）: ' + (error?.message ?? error));
      }
      throw error;
    }
  }

  // 列表 / 搜索（返回 [{key, keywords}]，供工具端点压缩成短文本）
  async function listMemes(query) {
    if (query) {
      const r = await call('/search', { query });
      return (r.keys ?? []).map((k) => ({ key: k }));
    }
    const r = await call('/list');
    return r.memes ?? [];
  }

  // 图片源解析：QQ号/纯数字字符串 → 头像；'me' → 机器人头像；http(s) URL → 下载
  async function resolveImageSource(src, selfId) {
    const s = String(src ?? '').trim();
    if (!s) throw new Error('图片源为空');
    if (/^me$/i.test(s)) { if (!selfId) throw new Error('selfId 缺失，无法解析 me'); return avatarUrlOf(selfId); }
    if (/^\d{5,11}$/.test(s)) return avatarUrlOf(s);
    if (/^https?:\/\//i.test(s)) return s;
    throw new Error('图片源仅支持 QQ 号（头像）、"me"（自己头像）或 http(s) 图片直链，收到: ' + s.slice(0, 60));
  }

  // 生成并落盘：{key, imageSources, texts} → { file: 'file:///D:/qqbot/outbox/meme-xxx.png', bytes, mime, key }
  async function makeMeme({ key, imageSources = [], texts = [], options = {}, selfId }) {
    if (!enabled()) throw new Error('meme 功能未开启（config.json meme.enabled）');
    const cleanKey = String(key ?? '').trim();
    if (!cleanKey) throw new Error('meme key 为空');
    const images = [];
    for (const src of imageSources.slice(0, 4)) {
      const url = await resolveImageSource(src, selfId);
      const buf = await downloadRecordBuffer(url); // 复用：http 下载（qlogo 头像是 https 直链）
      if (!buf || buf.length < 64) throw new Error('图片源下载失败: ' + String(src));
      if (buf.length > 12 * 1024 * 1024) throw new Error('图片源超 12MB');
      const name = String(url).includes('qlogo') ? 'avatar.jpg' : 'img.jpg';
      images.push({ name, data_b64: buf.toString('base64') });
    }
    const r = await call('/meme', { key: cleanKey, images, texts: texts.map(String), options });
    const b64 = String(r.image_b64 || '');
    if (!b64) throw new Error('meme 服务没有返回图片');
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length < 100) throw new Error('meme 产物异常（<100 字节）');
    // meme-generator 可能输出 gif/png/jpg（petpet 等是动图 GIF）——按魔数定扩展名
    const magic = bytes.subarray(0, 6);
    let ext = 'png';
    if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) ext = 'gif';        // GIF8
    else if (magic[0] === 0xff && magic[1] === 0xd8) ext = 'jpg';                        // JPEG
    else if (magic[0] === 0x89 && magic[1] === 0x50) ext = 'png';                        // PNG
    else if (magic[0] === 0x42 && magic[1] === 0x4d) ext = 'bmp';                        // BM
    fs.mkdirSync(outboxDir(), { recursive: true });
    const file = path.join(outboxDir(), 'meme-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext);
    fs.writeFileSync(file, bytes);
    appendActivity?.('表情包生成：' + cleanKey + (texts.length ? '（' + texts.join('/') + '）' : ''));
    return { key: cleanKey, bytes, file: 'file:///' + file.replace(/\\/g, '/'), size: bytes.length, ext };
  }

  return { enabled, listMemes, makeMeme, avatarUrlOf, _resetBreaker: () => { downUntil = 0; } };
}
