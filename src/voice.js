// 鲸鲸 3.0 语音模块（P1）：
//   出向：text → GPT-SoVITS api_v2 /tts → wav → silk-wasm encode → record 段 base64 发送
//   入向：record url → 下载 → silk-wasm decode → pcm → whisper HTTP /asr → 文字
//   TTS 懒启动：第一次用时拉起 api_v2 进程（冷启动 10-60s），空闲 N 分钟后 POST /control exit 释放显存。
//   短语缓存：同文本 + 同音色配置 → 直接复用 silk 字节（磁盘 state/voice-cache）。
// 纯副作用都集中在本模块，bridge 只调用；测试见 tests/test-voice.mjs。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { encode as silkEncode, decode as silkDecode, getDuration as silkGetDuration, isSilk, isWav } from 'silk-wasm';

const TTS_COLD_START_MS = 120000;   // 拉起 api_v2 + 加载模型的最大等待
const TTS_REQUEST_TIMEOUT_MS = 120000;
const ASR_REQUEST_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 20000;
const ASR_CIRCUIT_BREAK_MS = 5 * 60 * 1000; // ASR 服务连挂 5 分钟内不再尝试，避免每条语音都等超时

// int16 pcm → 44 字节头 RIFF/WAVE（16bit 单声道）。
// 入参两种形态：Int16Array（样本）或 Buffer/Uint8Array（s16le 字节流，silk-wasm decode().data 就是这种）。
export function wavFromPcm16(pcm, sampleRate) {
  let dataBytes;
  if (pcm instanceof Int16Array) {
    dataBytes = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) dataBytes.writeInt16LE(pcm[i], i * 2);
  } else {
    // 字节流：原样即 data 块（长度必须是偶数）
    const bytes = Buffer.from(pcm ?? []);
    dataBytes = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - (bytes.length % 2));
  }
  const buf = Buffer.alloc(44 + dataBytes.length);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes.length, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);            // block align
  buf.writeUInt16LE(16, 34);           // bits
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes.length, 40);   // data 块字节数
  dataBytes.copy(buf, 44);
  return buf;
}

export function createVoiceModule({ cfg, log, appendActivity }) {
  const voiceCfg = () => cfg.voice ?? {};
  const enabled = () => voiceCfg().enabled !== false;

  // ── TTS 进程管理（懒启动 + 空闲退出）─────────────────────────────────
  let ttsProc = null;
  let ttsLastUse = 0;
  let ttsStarting = null;
  let idleTimer = null;

  function ttsUrl() { return String(voiceCfg().ttsUrl || 'http://127.0.0.1:9880').replace(/\/+$/, ''); }

  async function ttsAlive() {
    try {
      const res = await fetch(ttsUrl() + '/tts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(3000)
      });
      return res.status < 500; // 400（缺参数）也算活着
    } catch { return false; }
  }

  function armIdleShutdown() {
    if (idleTimer) clearTimeout(idleTimer);
    const minutes = Number(voiceCfg().idleShutdownMinutes ?? 15);
    if (!(minutes > 0)) return; // 0/负数 = 常驻不退出
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (Date.now() - ttsLastUse < minutes * 60 * 1000) { armIdleShutdown(); return; }
      if (ttsProc || (await ttsAlive())) {
        try {
          await fetch(ttsUrl() + '/control?command=exit', { signal: AbortSignal.timeout(5000) });
          log('[voice] TTS 空闲退出（释放显存）');
          appendActivity?.('语音引擎空闲退出');
        } catch {}
      }
      ttsProc = null;
    }, minutes * 60 * 1000 + 5000);
    idleTimer.unref?.();
  }

  // Bug #24（与 watchdog eb5598e 同源）：console 子系统解释器（PE subsystem=3）配 detached:true，
  // 等于给「本来没有控制台」的进程传 DETACHED_PROCESS —— 系统会当场再分配一个新控制台。
  // windowsHide:true 只在 CreateProcess 阶段设 SW_HIDE，管不了事后新建的控制台；
  // Win11 默认终端把它显示成 Windows Terminal 窗口 → 主人看到「后台一直弹窗」。
  // 换成同目录 pythonw.exe（subsystem=2，GUI）后永不分配控制台；stdout/stderr 已重定向到
  // tts.out.log / tts.err.log，print() 照常可用（不是 pythonw 常见的 sys.stdout is None 那个坑）。
  // 注意：不要写死 Scripts/ 子目录 —— conda 环境的 pythonw.exe 就在环境根目录，
  // 只有 venv 才在 Scripts/ 下；用同目录探测对两者都成立。
  function pythonwIfPossible(exe) {
    try {
      const cand = path.join(path.dirname(exe), 'pythonw.exe');
      if (fs.existsSync(cand)) return cand;
    } catch {}
    return exe;
  }

  async function ensureTtsServer() {
    if (await ttsAlive()) return true;
    if (ttsStarting) return ttsStarting;
    ttsStarting = (async () => {
      try {
        const v = voiceCfg();
        if (v.lazy === false) {
          log('[voice] TTS 不在线且未配置自启动（voice.lazy=false），请用看门狗常驻方案');
          return await ttsAlive();
        }
        const pythonExe = pythonwIfPossible(String(v.ttsPython || 'D:/ai-tools/miniconda3/envs/sovits/python.exe'));
        const repoDir = String(v.ttsCwd || 'D:/ai-tools/GPT-SoVITS');
        const port = Number(new URL(ttsUrl()).port || 9880);
        const args = ['api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'];
        log(`[voice] 拉起 GPT-SoVITS api_v2（冷启动约 10-60s，解释器 ${path.basename(pythonExe)}）…`);
        const out = fs.openSync('D:/qqbot/logs/tts.out.log', 'a');
        const err = fs.openSync('D:/qqbot/logs/tts.err.log', 'a');
        ttsProc = spawn(pythonExe, args, { cwd: repoDir, detached: true, windowsHide: true, stdio: ['ignore', out, err] });
        ttsProc.unref();
        // Bug #16：父进程不再需要这两个 fd（spawn 已把它们复制给子进程）。
        // 不关会随每次 TTS 冷启动累积句柄，并把 tts.out.log / tts.err.log 锁住无法读取（同 watchdog Bug #13）。
        try { fs.closeSync(out); } catch {}
        try { fs.closeSync(err); } catch {}
        const t0 = Date.now();
        while (Date.now() - t0 < TTS_COLD_START_MS) {
          await new Promise((r) => setTimeout(r, 3000));
          if (await ttsAlive()) {
            log(`[voice] TTS 就绪（耗时 ${Math.round((Date.now() - t0) / 1000)}s，pid ${ttsProc.pid}）`);
            return true;
          }
        }
        log('[voice] TTS 冷启动超时（120s）');
        return false;
      } finally {
        ttsStarting = null;
      }
    })();
    return ttsStarting;
  }

  // ── 短语缓存 ─────────────────────────────────────────────────────────
  function cacheDir() { return String(voiceCfg().cacheDir || 'D:/qqbot/qq-bridge/state/voice-cache'); }
  function voiceFingerprint() {
    // 缓存指纹必须覆盖所有会传给 GPT-SoVITS 的合成参数，否则改参数后旧 silk 复用 → 听着音色对但发声细节陈旧。
    // 漏字段会导致 Bug #6：topK/topP/temperature/textSplitMethod 改了但 cache 不失效。
    const v = voiceCfg();
    const parts = [
      v.refAudioPath, v.promptText, v.promptLang, v.textLang,
      v.speedFactor, v.ttsModel,
      v.topK, v.topP, v.temperature, v.textSplitMethod,
    ];
    return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 10);
  }
  function cacheGet(text) {
    try {
      const file = path.join(cacheDir(), `${voiceFingerprint()}-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 20)}.silk`);
      if (fs.existsSync(file)) return { silk: fs.readFileSync(file), fromCache: true };
    } catch {}
    return null;
  }
  function cachePut(text, silk) {
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      const file = path.join(cacheDir(), `${voiceFingerprint()}-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 20)}.silk`);
      fs.writeFileSync(file, silk);
      // 缓存目录超过 300 个文件时删最旧的一半，防止无限膨胀
      const files = fs.readdirSync(cacheDir()).map((f) => ({ f, m: fs.statSync(path.join(cacheDir(), f)).mtimeMs })).sort((a, b) => b.m - a.m);
      for (const old of files.slice(300)) fs.rmSync(path.join(cacheDir(), old.f), { force: true });
    } catch {}
  }

  // ── 出向：text → { silk(Buffer), durationMs } ────────────────────────
  async function synthesize(text) {
    const clean = String(text ?? '').trim();
    const maxChars = Number(voiceCfg().maxChars ?? 120);
    if (!clean) throw new Error('语音文本为空');
    if (clean.length > maxChars) throw new Error(`语音文本过长（${clean.length} 字 > 上限 ${maxChars}）：语音只适合短句，长内容请用文字分条发`);
    const cached = cacheGet(clean);
    if (cached) {
      ttsLastUse = Date.now(); armIdleShutdown();
      const duration = await silkDurationOf(cached.silk);
      return { silk: cached.silk, durationMs: duration, cached: true };
    }
    if (!(await ensureTtsServer())) throw new Error('语音引擎（GPT-SoVITS）不在线且拉起失败，看 logs/tts.err.log');
    const v = voiceCfg();
    const body = {
      text: clean,
      text_lang: String(v.textLang || 'zh'),
      ref_audio_path: String(v.refAudioPath || ''),
      prompt_text: String(v.promptText || ''),
      prompt_lang: String(v.promptLang || 'zh'),
      top_k: Number(v.topK ?? 15),
      top_p: Number(v.topP ?? 1),
      temperature: Number(v.temperature ?? 1),
      text_split_method: String(v.textSplitMethod || 'cut5'),
      media_type: 'wav',
      streaming_mode: false,
      speed_factor: Number(v.speedFactor ?? 1),
    };
    if (!body.ref_audio_path) throw new Error('voice.refAudioPath 未配置（参考音频）');
    const res = await fetch(ttsUrl() + '/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch { try { detail = (await res.text()).slice(0, 300); } catch {} }
      throw new Error(`TTS 合成失败 HTTP ${res.status}${detail ? '：' + detail : ''}`);
    }
    const wav = Buffer.from(await res.arrayBuffer());
    if (!isWav(wav)) throw new Error('TTS 返回的不是 wav（检查 api_v2 配置 media_type=wav）');
    ttsLastUse = Date.now(); armIdleShutdown();
    const { data } = await silkEncode(wav, 0); // 0 = 从 wav 头读采样率
    const silk = Buffer.from(data);
    cachePut(clean, silk);
    const duration = await silkDurationOf(silk);
    return { silk, durationMs: duration, cached: false };
  }

  async function silkDurationOf(silkBuf) {
    try {
      const ms = await silkGetDuration(silkBuf); // silk-wasm getDuration 单位=毫秒（frameMs 默认 20）
      if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
    } catch {}
    return null;
  }

  // ── 入向：record bytes → 文字 ─────────────────────────────────────────
  let asrDownUntil = 0;
  async function transcribeRecord(buf) {
    if (!isSilk(buf)) return { ok: false, reason: 'format' }; // amr 等旧格式：保留占位
    if (Date.now() < asrDownUntil) return { ok: false, reason: 'asr-down' };
    const sampleRate = Number(voiceCfg().inboundSampleRate ?? 24000);
    let decoded;
    try {
      decoded = await silkDecode(buf, sampleRate);
    } catch {
      return { ok: false, reason: 'decode' };
    }
    const wav = wavFromPcm16(decoded.data, sampleRate);
    let text = '';
    try {
      const res = await fetch(String(voiceCfg().asrUrl || 'http://127.0.0.1:9881') + '/asr', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio_b64: wav.toString('base64'), sample_rate: sampleRate }),
        signal: AbortSignal.timeout(ASR_REQUEST_TIMEOUT_MS)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      text = String(body.text ?? '').trim();
      return { ok: true, text, durationMs: Math.round(decoded.duration || 0) }; // decode.duration 单位=毫秒
    } catch (error) {
      asrDownUntil = Date.now() + ASR_CIRCUIT_BREAK_MS;
      log('[voice] ASR 失败（熔断 5 分钟）: ' + (error?.message ?? error));
      return { ok: false, reason: 'asr-error' };
    }
  }

  return {
    enabled,
    synthesize,
    transcribeRecord,
    ensureTtsServer,
    ttsAlive,
    wavFromPcm16,
    _resetAsrBreaker: () => { asrDownUntil = 0; },
  };
}

export async function downloadRecordBuffer(urlOrFile, fetchImpl) {
  // OneBot record 段的 file 字段可能是 url、file:// 路径或 base64://。
  const src = String(urlOrFile ?? '');
  if (!src) throw new Error('record 段缺少 file/url');
  if (src.startsWith('base64://')) return Buffer.from(src.slice('base64://'.length), 'base64');
  if (src.startsWith('data:')) {
    const idx = src.indexOf(',');
    return Buffer.from(idx >= 0 ? src.slice(idx + 1) : '', 'base64');
  }
  if (src.startsWith('file://')) {
    // Node fetch 不支持 file:// 协议，本地路径直接读盘
    const p = decodeURIComponent(src.replace(/^file:\/\/\/?/, '')).replace(/^\//, '');
    return fs.readFileSync(p);
  }
  if (/^[A-Za-z]:[\\/]/.test(src)) return fs.readFileSync(src); // OneBot 有时给裸 Windows 路径
  if (src.startsWith('\\') || src.startsWith('/')) return fs.readFileSync(src); // UNC/POSIX 绝对路径
  const res = await (fetchImpl || fetch)(src, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`下载语音失败 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export { isSilk, isWav, silkEncode, silkDecode, silkGetDuration as getDuration };
