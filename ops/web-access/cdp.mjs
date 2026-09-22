#!/usr/bin/env node
// web-access：零依赖 CDP 驱动（Node 22+ 自带 fetch / WebSocket）
// 用法见同目录 SKILL.md。核心：连到本机已开启调试端口的 Chromium 浏览器（Edge/Chrome），
// 直接操作用户"现有的浏览器"——包括他所有登录态和标签页。
//
// 命令：
//   status                          连接自检 + 列出标签页
//   tabs                            列出标签页（JSON）
//   new <url>                       新标签页打开并返回 tab id
//   goto <url> [--tab N|id]         导航
//   text [--tab N] [--max 4000]     提取页面可见文本
//   html [--tab N] [--max 4000]     提取 HTML
//   shot <out.png> [--tab N] [--full]  截图（默认存到 D:\qqbot\outbox）
//   eval "<js>" [--tab N] [--await] 执行 JS（--await 等待 Promise）
//   click "<selector>" [--tab N]    点击元素
//   type "<selector>" "<text>" [--tab N]  输入文本（含 input/change 事件）
//   keys "<key>" [--tab N]          发送按键（Enter/Tab/Escape/ArrowDown...）
//   wait "<selector>" [--timeout 10000] [--tab N]   等待元素出现
//   close <tabId>                   关闭标签页
// 通用参数：--port 9222 / --json（机器可读输出）
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const argv = process.argv.slice(2);
const cmd = (argv.shift() ?? 'status').toLowerCase();
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[k] = true;
    else { flags[k] = next; i++; }
  } else positional.push(a);
}
const port = Number(flags.port) || 9222;
const asJson = !!flags.json;
const BASE = `http://127.0.0.1:${port}`;
const OUTBOX = 'D:\\qqbot\\outbox';

const die = (msg, extra) => {
  console.error(`❌ ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
};

async function listTargets() {
  let res;
  try {
    res = await fetch(`${BASE}/json/list`);
  } catch (e) {
    die(
      `连不上浏览器调试端口 ${BASE} —— 浏览器没有以调试模式启动。`,
      '请先运行：D:\\qqbot\\web-access\\start-edge-debug.cmd（会重启 Edge 并保留标签页），\n' +
      '或者手动：msedge.exe --remote-debugging-port=9222 --restore-last-session'
    );
  }
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function pickTarget() {
  const pages = await listTargets();
  if (!pages.length) die('没有可用标签页（type=page）。先用 new <url> 打开一个。');
  const t = flags.tab;
  if (t === undefined) return pages[0];
  if (/^\d+$/.test(String(t))) {
    const idx = Number(t);
    if (idx >= pages.length) die(`标签序号越界：${idx}（共 ${pages.length} 个）`);
    return pages[idx];
  }
  const found = pages.find((p) => p.id === t);
  if (!found) die(`找不到标签页 id=${t}`);
  return found;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    let opened = false;
    const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} reject(new Error('CDP WebSocket 连接超时')); } }, 10000);
    ws.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send(method, params = {}, timeoutMs = 30000) {
          const id = ++seq;
          return new Promise((res, rej) => {
            const to = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} 超时`)); }, timeoutMs);
            pending.set(id, { res, rej, to });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch {} },
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, to } = pending.get(msg.id);
        clearTimeout(to);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`CDP 错误(${msg.error.code}): ${msg.error.message}`));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => { if (!opened) reject(new Error('CDP WebSocket 错误：' + (e?.message ?? 'unknown'))); });
    ws.addEventListener('close', () => { if (!opened) reject(new Error('CDP WebSocket 已关闭')); });
  });
}

async function withTab(fn) {
  const target = await pickTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    return await fn(cdp, target);
  } finally {
    cdp.close();
  }
}

const out = (obj, human) => {
  if (asJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(human ?? JSON.stringify(obj, null, 2));
};

const EXPR_TEXT = `(() => {
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','CANVAS']);
  const walk = (el, acc) => {
    if (!el) return acc;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const t = n.textContent.replace(/\\s+/g,' ').trim(); if (t) acc.push(t); }
      else if (n.nodeType === 1 && !skip.has(n.tagName)) {
        const st = getComputedStyle(n);
        if (st.display !== 'none' && st.visibility !== 'hidden') walk(n, acc);
      }
    }
    return acc;
  };
  return walk(document.body, []).join('\\n');
})()`;

async function main() {
  switch (cmd) {
    case 'status': {
      const pages = await listTargets();
      const ver = await (await fetch(`${BASE}/json/version`)).json().catch(() => ({}));
      out({ ok: true, browser: ver.Browser ?? '(未知)', port, tabs: pages.length }, `✅ 已连接 ${ver.Browser ?? '浏览器'}（端口 ${port}），共 ${pages.length} 个标签页`);
      for (const [i, p] of pages.entries()) console.log(`  [${i}] ${p.title?.slice(0, 60) ?? ''}  →  ${p.url.slice(0, 90)}`);
      break;
    }
    case 'tabs': {
      const pages = await listTargets();
      out(pages.map((p, i) => ({ index: i, id: p.id, title: p.title, url: p.url })), pages.map((p, i) => `[${i}] ${p.title?.slice(0, 60)}\n    ${p.url.slice(0, 100)}`).join('\n'));
      break;
    }
    case 'new': {
      const url = positional[0] ?? 'about:blank';
      const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
      if (!res.ok) die(`新建标签页失败：HTTP ${res.status}`);
      const t = await res.json();
      out({ ok: true, id: t.id, url: t.url }, `✅ 已新开标签页：${t.url}\n   id=${t.id}`);
      break;
    }
    case 'close': {
      const id = positional[0];
      if (!id) die('用法：close <tabId>');
      const res = await fetch(`${BASE}/json/close/${id}`);
      out({ ok: res.ok }, res.ok ? '✅ 已关闭' : '❌ 关闭失败');
      break;
    }
    case 'goto': {
      const url = positional[0];
      if (!url) die('用法：goto <url>');
      const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      await withTab(async (cdp) => {
        await cdp.send('Page.navigate', { url: full });
        await sleep(Number(flags.wait) || 2500);
        const t = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
        out({ ok: true, url: full, title: t.result?.value }, `✅ 已导航到 ${full}\n   标题：${t.result?.value ?? ''}`);
      });
      break;
    }
    case 'text':
    case 'html': {
      const max = Number(flags.max) || 4000;
      await withTab(async (cdp) => {
        const expr = cmd === 'text' ? EXPR_TEXT : 'document.documentElement.outerHTML';
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 60000);
        const val = String(r.result?.value ?? '');
        out({ ok: true, length: val.length, content: val.slice(0, max) }, val.slice(0, max) + (val.length > max ? `\n…（共 ${val.length} 字符，已截断）` : ''));
      });
      break;
    }
    case 'shot': {
      const fileArg = positional[0];
      fs.mkdirSync(OUTBOX, { recursive: true });
      const file = fileArg
        ? (path.isAbsolute(fileArg) ? fileArg : path.join(OUTBOX, fileArg))
        : path.join(OUTBOX, `web-${Date.now()}.png`);
      await withTab(async (cdp) => {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!flags.full }, 60000);
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        const url = 'file:///' + file.replace(/\\/g, '/');
        out({ ok: true, file, size: fs.statSync(file).size, url }, `✅ 截图已保存：${file}（${Math.round(fs.statSync(file).size / 1024)} KB）\n   要发给主人的话：qq_send_image 的 file 参数填 ${url}`);
      });
      break;
    }
    case 'eval': {
      const js = positional.join(' ');
      if (!js) die('用法：eval "document.title" [--await]');
      await withTab(async (cdp) => {
        const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: !!flags.await }, 60000);
        if (r.exceptionDetails) die('JS 执行异常：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
        const v = r.result?.value;
        out({ ok: true, result: v }, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      });
      break;
    }
    case 'click': {
      const sel = positional[0];
      if (!sel) die('用法：click "<selector>"');
      await withTab(async (cdp) => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'NOT_FOUND'; el.scrollIntoView({block:'center'}); el.click(); return 'CLICKED:' + (el.innerText || el.value || el.tagName).slice(0,60); })()`,
          returnByValue: true,
        });
        const v = String(r.result?.value ?? '');
        if (v === 'NOT_FOUND') die(`找不到元素：${sel}`);
        out({ ok: true, result: v }, `✅ ${v}`);
      });
      break;
    }
    case 'type': {
      const [sel, text] = positional;
      if (!sel || text === undefined) die('用法：type "<selector>" "<text>"');
      await withTab(async (cdp) => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'NOT_FOUND';
  el.focus();
  if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
  else { el.value = ${JSON.stringify(text)}; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'OK';
})()`,
          returnByValue: true,
        });
        const v = String(r.result?.value ?? '');
        if (v === 'NOT_FOUND') die(`找不到元素：${sel}`);
        out({ ok: true }, `✅ 已输入 ${String(text).length} 个字符到 ${sel}`);
      });
      break;
    }
    case 'keys': {
      const key = positional[0] ?? 'Enter';
      await withTab(async (cdp) => {
        const map = { Enter: { key: 'Enter', code: 'Enter', keyCode: 13 }, Tab: { key: 'Tab', code: 'Tab', keyCode: 9 }, Escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 } };
        const k = map[key] ?? { key, code: key, keyCode: 0 };
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: k.key.length === 1 ? k.key : undefined });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
        out({ ok: true, key }, `✅ 已发送按键 ${key}`);
      });
      break;
    }
    case 'wait': {
      const sel = positional[0];
      if (!sel) die('用法：wait "<selector>" [--timeout 10000]');
      const timeout = Number(flags.timeout) || 10000;
      await withTab(async (cdp) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
          const r = await cdp.send('Runtime.evaluate', { expression: `!!document.querySelector(${JSON.stringify(sel)})`, returnByValue: true });
          if (r.result?.value === true) { out({ ok: true, waitedMs: Date.now() - t0 }, `✅ 元素已出现（${Date.now() - t0} ms）：${sel}`); return; }
          await sleep(300);
        }
        die(`等待超时（${timeout} ms）：${sel}`);
      });
      break;
    }
    default:
      die(`未知命令：${cmd}。可用：status/tabs/new/goto/text/html/shot/eval/click/type/keys/wait/close`);
  }
}

main().catch((e) => die(String(e?.message ?? e)));
