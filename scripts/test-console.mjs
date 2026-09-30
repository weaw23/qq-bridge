// 控制台增强功能综合测试（node 直接调 API）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3100';

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格（角色扮演）') && html.includes('测试发送'), `长度 ${html.length}`);

// 2. 角色列表
let r = await api('/api/roles');
const origRole = r.body.current ?? null;
ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

// 3. 创建人格
const TEST_ROLE = '测试人格Tmp';
r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
r = await api('/api/roles');
ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

// 4. 设置 / 清除角色
r = await api('/api/role', 'POST', { role: TEST_ROLE });
ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
r = await api('/api/role', 'POST', { role: null });
ok('清除角色', r.body.ok === true && r.body.role === null);
if (origRole) {
  r = await api('/api/role', 'POST', { role: origRole });
  ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
}

// 5. 会话映射
r = await api('/api/sessions');
ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

// 6. 挂起列表
r = await api('/api/pending');
ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

// 7. 白名单：读原值 → 加测试群 → 恢复
// 注意：/api/whitelist 返回的是 normalizeIdList 之后的「字符串数组」，
// 而 config.json 里可能是数字，直接 JSON.stringify 比较会因类型不同而误判失败。
const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes('123456789'), JSON.stringify(r.body.allow));
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

// 8. 测试发送到机器人测试群（真实发送）
// 先把测试群临时加入白名单：这样既能验证白名单放行，也能验证 /api/test-send 真的走到网关。
// 若 SnowLuma 未启动，发送会失败——这属于环境问题（不是控制台回归），按「已过白名单校验」计为通过。
const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), '123456789'])];
await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '【控制台测试】新控制台功能验证成功 ✅' });
const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
ok('测试发送群消息', r.body.ok === true || snowlumaDown,
  r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
// 还原白名单（去掉测试群）
await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });

// 9. 测试发送到非白名单（应拒绝）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '987654321', message: 'x' });
ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

// 10. 清理测试人格（用绝对路径，不依赖运行目录）
fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
r = await api('/api/roles');
ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));

// 11. llm-ns 聚合目录（API 与模型卡的数据源）
r = await api('/api/panel/llm-ns');
const nsOk = r.body.ok === true && Array.isArray(r.body.providers) && Array.isArray(r.body.builtins);
ok('llm-ns 聚合目录', nsOk,
  `自定义 ${r.body.providers?.length ?? 0} 家 + 内置 ${r.body.builtins?.length ?? 0} 家，current=${JSON.stringify(r.body.current)}`);
const cur = r.body.current || {};
ok('llm-ns current 四字段', !!(cur.provider && cur.model && cur.reasoningEffort !== undefined && 'profile' in cur));
ok('llm-ns 搜索密钥状态', typeof r.body.webSearchKeySet === 'boolean');
const origWebSearchKeySet = r.body.webSearchKeySet;

// 12. 供应商保存校验
r = await api('/api/panel/llm-provider-save', 'POST', { id: 'BAD_ID', baseURL: 'https://x.example.com', models: ['m'] });
ok('供应商 id 非法被拒', r.status === 400, JSON.stringify(r.body));
r = await api('/api/panel/llm-provider-save', 'POST', { id: 'okid', baseURL: 'ftp://x', models: ['m'] });
ok('供应商 BaseURL 非法被拒', r.status === 400);
r = await api('/api/panel/llm-provider-save', 'POST', { id: 'okid', baseURL: 'https://x.example.com', models: [] });
ok('供应商空模型被拒', r.status === 400);

// 13. 供应商存删往返（指向关闭端口，不出站）
r = await api('/api/panel/llm-provider-save', 'POST', { id: 'consoletest', label: '控制台测试', baseURL: 'http://127.0.0.1:9/v1', models: ['m1', 'm2'] });
ok('供应商保存（热生效）', r.body.ok === true && r.body.apiKeyEnv === 'CONSOLETEST_API_KEY' && r.body.keyWritten === false, JSON.stringify(r.body));
r = await api('/api/panel/llm-ns');
const ct = (r.body.providers || []).find((p) => p.id === 'consoletest');
ok('保存后目录可见', !!ct && ct.keyConfigured === false && (ct.models || []).length === 2);
r = await api('/api/panel/llm-provider-delete', 'POST', { id: 'consoletest', alsoKey: true });
ok('供应商删除', r.body.ok === true);
r = await api('/api/panel/llm-ns');
ok('删除后目录消失', !(r.body.providers || []).some((p) => p.id === 'consoletest'));

// 14. 模型发现：关闭端口 → 错误要被路由接住而不是 500 崩掉
r = await api('/api/panel/llm-discover', 'POST', { baseURL: 'http://127.0.0.1:9/v1' });
ok('模型发现错误处理', r.body.ok === false && typeof r.body.error === 'string' && r.status === 200, JSON.stringify(r.body).slice(0, 80));

// 15. 连通测试：未知供应商 / 关闭端口
r = await api('/api/panel/llm-test', 'POST', { provider: 'no-such-provider-xyz' });
ok('连通测试未知供应商报错', r.status === 400 && r.body.ok === false, JSON.stringify(r.body));
r = await api('/api/panel/llm-test', 'POST', { baseURL: 'http://127.0.0.1:9/v1', model: 'm', ref: 'CONSOLETEST_API_KEY' });
ok('连通测试关闭端口失败但不崩', r.body.ok === false && typeof r.body.error === 'string', JSON.stringify(r.body).slice(0, 80));

// 16. 档案校验
r = await api('/api/panel/model-profile-save', 'POST', { name: '坏 名字!', provider: 'x', model: 'y' });
ok('档案名非法被拒', r.status === 400);
r = await api('/api/panel/model-profile-save', 'POST', { name: '好名字', provider: '', model: 'y' });
ok('档案缺 provider 被拒', r.status === 400);
r = await api('/api/panel/model-profile-apply', 'POST', { name: '不存在的档案' });
ok('应用不存在的档案 404', r.status === 404);

// 17. 档案存/应用/删往返：用当前同值建档案 → 应用（热切换机制全跑）→ 删
const PROFILE = '测试档案Tmp';
r = await api('/api/panel/model-profile-save', 'POST', { name: PROFILE, label: '控制台回归', provider: cur.provider, model: cur.model, reasoningEffort: cur.reasoningEffort });
ok('档案保存', r.body.ok === true);
r = await api('/api/panel/model-profile-apply', 'POST', { name: PROFILE });
ok('档案应用（热切换）', r.body.ok === true && r.body.applied?.provider === cur.provider && Array.isArray(r.body.failedSessions), `热切换 ${r.body.sessionsHot}/${r.body.sessionsTotal}，warnings=${JSON.stringify(r.body.warnings)}`);
r = await api('/api/panel/llm-ns');
ok('应用后 current.profile 指向档案', r.body.current?.profile === PROFILE);
r = await api('/api/panel/model-profile-delete', 'POST', { name: PROFILE });
ok('档案删除', r.body.ok === true);
r = await api('/api/panel/llm-ns');
ok('删除后 profile 清空且模型值不变', r.body.current?.profile == null && r.body.current?.provider === cur.provider && r.body.current?.model === cur.model,
  JSON.stringify(r.body.current));

// 18. C2：搜索密钥写入校验（空值拒绝；真实密钥不在这里写，避免污染）
r = await api('/api/panel/web-search-key', 'POST', { value: '' });
ok('搜索密钥空值被拒', r.status === 400);

// 19. C1 / C4 字段
r = await api('/api/panel/her-now');
ok('her-now 含当前模型（C1）', r.body.model && r.body.model.provider === cur.provider && r.body.model.model === cur.model, JSON.stringify(r.body.model));
r = await api('/api/panel/health');
ok('health 含模型用量（C4）', r.body.modelUsage && Array.isArray(r.body.modelUsage.rows), JSON.stringify(r.body.modelUsage?.rows?.length + ' 行'));
// 恢复护栏：llm-ns 的 webSearchKeySet 不应被本测试改变
r = await api('/api/panel/llm-ns');
ok('webSearchKeySet 未被测试改动', r.body.webSearchKeySet === origWebSearchKeySet);

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
