// 图片 + web_search 双修复回归测试（2026-09-30 主人报障：识别不了图片 / 工具无法调用浏览器）
// 用法：node ops/test-web-image-fixes.mjs
//
// 两处修复都是源码级断言（读文件比对关键串），不发起真实网络请求：
// - Bug E（web_search 间歇空结果）：safe-fetch.js 的 UA 从裸 "Mozilla/5.0" 升级为完整
//   浏览器 UA（裸 UA 被 Bing 间歇性软墙：HTTP 200 但 0 条 b_algo）；mcp-web-search-safe.js
//   增加 0 结果退避重试 + 仍为 0 时明确报错（旧版静默返回空 results，她拿到空结果
//   就以为「搜不了」，也没有重试机会）。
// - Bug F（图片识别）：根因在 DSH settings.yaml（仓库外，模型 input 声明缺失），
//   本文件不覆盖；settings.yaml 侧的修复记录在 STATE.md 与提交说明里。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, note = '') {
  if (cond) { pass++; console.log(`✅ ${name}${note ? '  ' + note : ''}`); }
  else { fail++; console.log(`❌ ${name}${note ? '  ' + note : ''}`); }
}

const safeFetchSrc = fs.readFileSync(path.join(ROOT, 'src', 'safe-fetch.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');

// ── Bug E：UA 升级 ─────────────────────────────────────────────────────────
console.log('── Bug E：Bing 软墙（UA + 重试 + 明确报错）──');
{
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  check('safe-fetch.js 使用完整浏览器 UA', safeFetchSrc.includes(`'user-agent': '${UA}'`), '裸 Mozilla/5.0 被 Bing 软墙');
  check('safe-fetch.js UA 注释说明软墙原因', /裸 "Mozilla\/5\.0" 会被 Bing 等搜索引擎间歇性软墙/.test(safeFetchSrc));
}

// ── Bug E：重试 + 明确报错 ────────────────────────────────────────────────
{
  check('存在 searchWeb 包装函数', /async function searchWeb\(query\)/.test(mcpSrc));
  check('web_search 工具改调 searchWeb', /await searchWeb\(clean\)/.test(mcpSrc), '不再直接调 bingSearch');
  check('0 结果退避 600ms 重试一次', /setTimeout\(r, 600\)/.test(mcpSrc));
  check('重试后仍 0 结果 → 明确报错', /疑似软墙/.test(mcpSrc) && /连续失败就先别搜了/.test(mcpSrc));
  check('Bing 请求带 form=QBRE', /searchParams\.set\('form', 'QBRE'\)/.test(mcpSrc));
  check('版本号 0.1.6', /version: '0\.1\.6'/.test(mcpSrc));
  check('工具描述说明失败会报错', /搜索失败会明确报错而不是返回空结果/.test(mcpSrc));
}

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
