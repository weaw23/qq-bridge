// 修掉孤立 \r + 重新校验 YAML
import fs from 'node:fs';
const p = 'C:/Users/HCK/.dsh/.agent-presets/qq-chat-v2/agent.cordis.yml';
let t = fs.readFileSync(p, 'utf8');
const before = (t.match(/\r/g) || []).length;
t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
fs.writeFileSync(p, t);
console.log('清理回车符:', before, '→', (t.match(/\r/g) || []).length);

// 用 DSH 自带的 yaml 校验
let yaml;
try { yaml = await import('file:///D:/DSH Desktop 2.0.5/resources/app.asar.unpacked/node_modules/yaml/dist/index.js'); }
catch (e) { console.log('导入 yaml 失败:', e.message.slice(0, 80)); process.exit(1); }
const parse = yaml.parse ?? yaml.default?.parse;
try {
  const doc = parse(t);
  const rows = Array.isArray(doc) ? doc : [];
  console.log('✅ YAML 合法；顶层行数:', rows.length);
  console.log('   行 id:', rows.map((r) => r.id).join(', '));
  const persona = rows.find((r) => r.id === 'persona');
  const text = persona?.config?.text ?? '';
  console.log('   persona 字符数:', text.length);
  console.log('   首行:', text.trim().split('\n')[0].trim().slice(0, 60));
  const need = ['女仆', '深度求索', '可爱', '不许说脏话', '好感度', '边界'];
  for (const w of need) if (!text.includes(w)) console.log('   ⚠️ 缺少关键词:', w);
  console.log('   关键词检查完成');
} catch (e) { console.log('❌ 仍然非法:', e.message.slice(0, 200)); }
