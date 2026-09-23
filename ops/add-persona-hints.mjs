import fs from 'node:fs';
const p = 'C:/Users/HCK/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml';
let t = fs.readFileSync(p, 'utf8');
const before = t.length;
const hint1 = '      【工具说明是精简版】工具列表里每行只有一句话；想知道某个工具的完整用法或参数细节，用 qq_help（传工具名即可，不传会列出全部工具名）。\n\n';
const hint2 = '      【群里的说话方式】群友流行的句式/腔调会以【群里的说话方式】出现在你视野里——那是你从群里学来的表达；用得上时自然一点地用，别硬套、别每句都用。\n\n';
if (!t.includes('工具说明是精简版')) {
  const a1 = '      【操作即动作，不是 API】';
  if (!t.includes(a1)) throw new Error('找不到【操作即动作】锚点');
  t = t.replace(a1, hint1 + a1);
  console.log('✅ 已加 qq_help 提示');
}
if (!t.includes('群里的说话方式')) {
  const a2 = '      【记忆】';
  if (!t.includes(a2)) throw new Error('找不到【记忆】锚点');
  t = t.replace(a2, hint2 + a2);
  console.log('✅ 已加表达库提示');
}
fs.writeFileSync(p, t);
console.log('人格文件:', before, '→', t.length, '字符');
