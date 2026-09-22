// 桥接重启助手：延迟几秒后以分离进程拉起新的桥接（避免端口占用竞态）
// 用法：node restart-helper.mjs <bridge.js 路径> <cwd> <out.log> <err.log> <延迟毫秒>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const bridge = process.argv[2] ?? 'D:\\qqbot\\qq-bridge\\src\\bridge.js';
const cwd = process.argv[3] ?? 'D:\\qqbot\\qq-bridge';
const out = process.argv[4] ?? 'D:\\qqbot\\logs\\bridge.out.log';
const err = process.argv[5] ?? 'D:\\qqbot\\logs\\bridge.err.log';
const delay = Number(process.argv[6] ?? 3000);

await new Promise((r) => setTimeout(r, Number.isFinite(delay) ? delay : 3000));

try {
  const child = spawn(process.execPath, [bridge], {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fs.openSync(out, 'a'), fs.openSync(err, 'a')],
    env: process.env
  });
  child.unref();
  fs.appendFileSync(err, `[restart-helper] 已拉起桥接 pid=${child.pid} @ ${new Date().toLocaleString('zh-CN')}\n`);
} catch (e) {
  fs.appendFileSync(err, `[restart-helper] 拉起失败：${e?.message ?? e}\n`);
}
process.exit(0);
