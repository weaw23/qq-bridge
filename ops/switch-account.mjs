// 换号辅助：把 SnowLuma 各账号的 OneBot 端口错开（避免抢 3000），并确保指定账号用标准端口
// 用法：node switch-account.mjs [新号UIN]   —— 不带参数只做端口去冲突
import fs from 'node:fs';
import path from 'node:path';

const CFG_DIR = 'D:\\qqbot\\SnowLuma\\config';
const STD = { http: 3000, ws: 3001 };
const files = fs.readdirSync(CFG_DIR).filter((f) => /^onebot_\d+\.json$/.test(f));
const target = process.argv[2] ? String(process.argv[2]).trim() : '';

console.log('发现账号配置:', files.join(', '));
console.log('目标账号:', target || '(未指定，仅做端口去冲突)');

let alt = 0;
for (const f of files) {
  const p = path.join(CFG_DIR, f);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const uin = f.match(/onebot_(\d+)\.json/)[1];
  const isTarget = target && uin === target;
  const httpSrv = j.networks?.httpServers?.[0];
  const wsSrv = j.networks?.wsServers?.[0];
  if (!httpSrv || !wsSrv) { console.log(`  ${uin}: 无网络配置，跳过`); continue; }
  if (isTarget) {
    httpSrv.port = STD.http; wsSrv.port = STD.ws;
    console.log(`  ✅ ${uin}（目标）→ http=${STD.http} ws=${STD.ws}`);
  } else if (uin === '3692140164' && !target) {
    // 未指定目标时：老号（可能已封）让出标准端口
    httpSrv.port = 3010; wsSrv.port = 3011;
    console.log(`  ↩️  ${uin}（旧号）→ http=3010 ws=3011（让出标准端口）`);
  } else if (!target) {
    alt += 1;
    httpSrv.port = 3010 + alt * 2; wsSrv.port = 3011 + alt * 2;
    console.log(`  ↔️  ${uin} → http=${httpSrv.port} ws=${wsSrv.port}（错开）`);
  } else if (!isTarget) {
    httpSrv.port = 3020; wsSrv.port = 3021;
    console.log(`  ↔️  ${uin}（非目标）→ http=3020 ws=3021（错开，避免抢端口）`);
  }
  j.mode = j.mode || 'overlay';
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
}
console.log('\n完成。检查结果：');
for (const f of fs.readdirSync(CFG_DIR).filter((x) => /^onebot_\d+\.json$/.test(x))) {
  const j = JSON.parse(fs.readFileSync(path.join(CFG_DIR, f), 'utf8'));
  console.log(`  ${f}: http=${j.networks.httpServers[0].port} ws=${j.networks.wsServers[0].port}`);
}
