// P7 迁移：config.json 新键 + 预停用已退群 + group-health.json 落账
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:\\qqbot\\qq-bridge';
const CFG = path.join(ROOT, 'config.json');
const HEALTH = path.join(ROOT, 'state', 'group-health.json');

const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));

// 1) 预停用：她的反馈明确记录 963871667（07:36）与 705154898（11:01）已被移出
const removed = {
  '963871667': '迁移自她的反馈：09-23 07:36 result=110 已被移出该群',
  '705154898': '迁移自她的反馈：09-23 11:01 result=110 已被移出该群',
};
const before = (c.allow?.groups ?? []).map(String);
c.groupsDisabled = Array.from(new Set([...(c.groupsDisabled ?? []).map(String), ...Object.keys(removed)]));
c.allow.groups = before.filter((g) => !removed[g]);

// 2) P7-E 会话轮换
c.socialV2 = c.socialV2 ?? {};
c.socialV2.sessionRotation = { enabled: true, maxAgeDays: 10 };

// 3) P7-B 黑话自动转正
c.slang = c.slang ?? {};
c.slang.autoConfirm = { enabled: true, minEvidence: 3, minSources: 1 };

// 4) P7-C 夜间维护
c.memory = c.memory ?? {};
c.memory.maintain = true;
c.memory.maintainHour = 1;
c.memory.decayDays = 60;

fs.writeFileSync(CFG + '.tmp', JSON.stringify(c, null, 2) + '\n');
fs.renameSync(CFG + '.tmp', CFG);

// 5) group-health.json：把迁移群记满 2 次 strike（面板可见原因）
const h = fs.existsSync(HEALTH) ? JSON.parse(fs.readFileSync(HEALTH, 'utf8')) : { strikes: {} };
for (const [gid, reason] of Object.entries(removed)) {
  h.strikes[gid] = { count: 2, lastAt: Date.now(), reason };
}
fs.writeFileSync(HEALTH + '.tmp', JSON.stringify(h, null, 2));
fs.renameSync(HEALTH + '.tmp', HEALTH);

console.log('迁移完成');
console.log('allow.groups =', JSON.stringify(c.allow.groups));
console.log('groupsDisabled =', JSON.stringify(c.groupsDisabled));
console.log('sessionRotation =', JSON.stringify(c.socialV2.sessionRotation));
console.log('autoConfirm =', JSON.stringify(c.slang.autoConfirm));
console.log('memory =', JSON.stringify({ maintain: c.memory.maintain, maintainHour: c.memory.maintainHour, decayDays: c.memory.decayDays }));
