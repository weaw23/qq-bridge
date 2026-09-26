// 出站敏感信息审计回归测试：**会话令牌打码放行，路径/凭据关键词照旧拦截**
//
// 背景（别删，这是这个策略存在的理由）：
//   桥接有三层出站审计，原来都是「命中就整条拦掉」：
//     bridge.js  auditAndSend()                        ← 出站总收口
//     bridge.js  回合结束的自动转发审计（10768 附近）   ← 她这一回合的最终回复
//     bridge.js  4 条 /api/send/* 路由（2611/3439/3567/5930）
//   而「命中」的判据有两类，混在一起判：
//     a) SENSITIVE_RE —— 本机路径 / UNC / 凭据关键词带赋值（启发式，会误伤）
//     b) hasKnownToken —— 文本里出现**某个会话的真实 agentToken**（精确匹配）
//   问题出在 b：令牌本来就不该出现在出站文本里，而**发送路径早已把它们打码**
//   （sendToQQ → redactKnownTokensOnly，把令牌换成 ***）。于是 b 的拦截除了
//   「把她的整条回复吃掉、再往群里丢一条 ⚠️ 吓人通知」之外没有额外保护，
//   而触发它的场景极其日常：她被提醒「未设置唤醒条件」之后，把自己的
//   wake-config 调用连同 `x-agent-token: <令牌>` 一起复述出来 → 整条被吃掉。
//   线上真实发生过三次（group:471975044，日志里三行「回复被安全策略拦截…（含会话令牌）」）。
//
// 现在的策略：
//   令牌 → 先打码（***），再拿**抹掉占位符的副本**去做启发式审计，命中才拦。
//   `token: ***` 这种残留不会再被关键词规则二次命中（占位符被抹掉后不满足 {3,}）。
//   路径与真实凭据关键词的拦截行为**完全不变**。
//
// 证据强度分层：
//   T 段  纯函数穷举（src/sensitive.js）—— 真正的行为验证，离线、不需要桥接在跑。
//   S 段  源码级接线检查 —— 只证明「那段代码还在、还是那个写法」，不是行为验证。
//
// 基线说明（先跑基线再改代码的规矩）：
//   本文件用 **命名空间导入**（`import * as S`）而不是具名导入，原因就是这个：
//   具名导入一个还不存在的导出，ESM 会在链接期直接失败，整个文件加载不了、
//   看起来是「测试文件坏了」而不是「断言红了」。命名空间导入下，改之前
//   `S.sensitiveVerdict` 是 undefined → T 段与 S 段**干净地红**，基线可读。
//
// 跑：node ops/test-sensitive.mjs
//     纯离线，不打任何 HTTP 接口，不改任何配置，不需要桥接在跑。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../src/sensitive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const sensitiveSrc = fs.readFileSync(path.join(ROOT, 'src', 'sensitive.js'), 'utf8');

// 假令牌：永远是假的，别把真令牌写进测试文件（这个文件要公开）。
const TOK_A = 'tkA_fake_0123456789abcdef';
const TOK_B = 'tkB_fake_fedcba9876543210';
const TOKENS = new Set([TOK_A, TOK_B]);

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? '  ' + extra : ''}`); }
}
function group(title) { console.log(`\n── ${title} ──`); }

const verdict = (text, tokens = TOKENS) =>
  (typeof S.sensitiveVerdict === 'function' ? S.sensitiveVerdict(text, tokens) : { blocked: undefined, masked: undefined, text: undefined, forAudit: undefined });

group('T 段 纯函数：令牌打码放行、其余照旧拦截');

{
  const v = verdict('今天陆战打得挺爽的');
  ok('T1 普通闲聊不拦、文本原样', v.blocked === false && v.masked === false && v.text === '今天陆战打得挺爽的');
}
{
  const v = verdict(`她把这个发出来了 ${TOK_A} 你看`);
  ok('T2 纯令牌：不拦、已打码、原文不留令牌',
    v.blocked === false && v.masked === true && !v.text.includes(TOK_A) && v.text.includes('***'));
}
{
  const v = verdict(`-H "x-agent-token: ${TOK_A}"`);
  ok('T3 令牌带关键词赋值（token: xxx）：打码后**不拦**（这正是线上被吃掉的那类文本）',
    v.blocked === false && v.masked === true && !v.text.includes(TOK_A));
}
{
  const v = verdict(`${TOK_A} 和 ${TOK_B} 还有 ${TOK_A}`);
  ok('T4 多个令牌 / 重复出现：全部打码',
    v.blocked === false && !v.text.includes(TOK_A) && !v.text.includes(TOK_B));
}
{
  const v = verdict('密码: hunter2');
  ok('T5 真实凭据关键词赋值（密码: hunter2）**仍拦**', v.blocked === true);
}
{
  const v = verdict('D:\\qqbot\\qq-bridge\\src\\bridge.js');
  ok('T6 本机盘符路径**仍拦**', v.blocked === true);
}
{
  const v = verdict('共享盘 \\\\fileserver\\share\\secret.txt');
  ok('T7 UNC 路径**仍拦**', v.blocked === true);
}
{
  const v = verdict('去 /etc/passwd 里翻');
  ok('T8 Unix 系统路径**仍拦**', v.blocked === true);
}
{
  const v = verdict(`api_key: sk-live-abcdefghijklmn`);
  ok('T9 api_key 赋值**仍拦**', v.blocked === true);
}
{
  const v = verdict(`她的令牌是 ${TOK_A}，路径 D:\\qqbot\\state`);
  ok('T10 令牌 + 真路径混排：仍然拦，但返回文本里没有令牌残留',
    v.blocked === true && !v.text.includes(TOK_A) && v.text.includes('***'));
}
{
  const v = verdict(`password=Sup3rSecret 顺手带上 ${TOK_A}`);
  ok('T11 令牌与真凭据同时出现：打码令牌后依然因凭据而拦',
    v.blocked === true && !v.text.includes(TOK_A));
}
{
  const v = verdict(`token: ${TOK_A}`);
  ok('T12 审计副本抹掉了占位符（否则 `token: ***` 会被自己的占位符二次命中）',
    typeof v.forAudit === 'string' && !v.forAudit.includes('***') && v.forAudit.trim() === 'token:',
    `forAudit=${JSON.stringify(v.forAudit)}`);
}
{
  const v1 = verdict('');
  const v2 = verdict(null);
  const v3 = verdict(undefined);
  ok('T13 空串 / null / undefined：不抛、不拦、返回空串',
    v1.blocked === false && v1.text === '' && v2.blocked === false && v2.text === '' && v3.blocked === false && v3.text === '');
}
{
  const v = verdict(`${TOK_A}`, new Set([null, '', undefined, TOK_A, 0]));
  ok('T14 令牌集合里的脏值（null/空串/数字）不误伤，真令牌照样打码',
    v.blocked === false && v.masked === true && !v.text.includes(TOK_A));
}
{
  const v = verdict(`前缀${TOK_A}后缀`);
  ok('T15 令牌作为更长文本的子串时也打码（includes 语义与旧实现一致）',
    v.text === '前缀***后缀');
}
{
  const v = verdict('她没有令牌也没有路径');
  ok('T16 空令牌集合时不误伤', verdict('她没有令牌也没有路径', new Set()).blocked === false && v.blocked === false);
}

group('S 段 源码接线：六个出站审计点都改走 sensitiveVerdict');

ok('S1 src/sensitive.js 导出 TOKEN_MASK / maskTokens / sensitiveVerdict',
  typeof S.TOKEN_MASK === 'string' && typeof S.maskTokens === 'function' && typeof S.sensitiveVerdict === 'function',
  `TOKEN_MASK=${JSON.stringify(S.TOKEN_MASK)}`);

ok('S2 src/sensitive.js 里 SENSITIVE_RE 仍然存在且仍是那个启发式并集（规则本身没被删）',
  typeof S.SENSITIVE_RE === 'function' || S.SENSITIVE_RE instanceof RegExp,
  `SENSITIVE_RE=${String(S.SENSITIVE_RE).slice(0, 40)}…`);

{
  const legacy = (bridgeSrc.match(/SENSITIVE_RE\.test\([^)]*\)\s*\|\|\s*hasKnownToken/g) || []).length;
  ok('S3 bridge.js 不再有「命中即整条拦」的旧写法（SENSITIVE_RE.test(...) || hasKnownToken）', legacy === 0, `旧写法=${legacy} 处`);
}
{
  const uses = (bridgeSrc.match(/sensitiveVerdict\(/g) || []).length;
  ok('S4 bridge.js 至少 6 处审计点改走 sensitiveVerdict（auditAndSend + 回合结束 + 4 条 /api/send 路由）', uses >= 6, `sensitiveVerdict= ${uses} 处`);
}
{
  const importLine = (bridgeSrc.match(/^import \{[^}]*\} from '\.\/sensitive\.js';$/m) || [''])[0];
  ok('S5 bridge.js 从 sensitive.js 导入了 sensitiveVerdict', /sensitiveVerdict/.test(importLine), importLine.trim());
}
{
  ok('S6 第二道防线还在：sendToQQ 发送前仍然 redactKnownTokensOnly',
    /function sendToQQ\(key, msg\) \{[\s\S]{0,200}redactKnownTokensOnly\(msg\)/.test(bridgeSrc));
}
{
  const m = bridgeSrc.match(/const plainGuard = sensitiveVerdict\([\s\S]{0,120}?const plain = plainGuard\.text;/);
  ok('S7 回合结束的最终回复用的是打码后的文本（不是只审计不替换）', Boolean(m));
}
{
  const hasTokenRef = /hasKnownToken/.test(bridgeSrc);
  ok('S8 bridge.js 里已不再有 hasKnownToken 变量（避免留下半死不活的旧判据）', hasTokenRef === false, hasTokenRef ? '仍有残留' : '');
}
{
  ok('S9 审计失败时仍然照旧通知（interceptNotify 开关保留）',
    /cfg\.security\?\.interceptNotify !== false/.test(bridgeSrc));
}
{
  const maskRefs = (sensitiveSrc.match(/TOKEN_MASK/g) || []).length;
  const ownLoop = /raw\.split\(token\)\.join|s\.split\(token\)\.join/.test(bridgeSrc);
  ok('S10 令牌打码只在 sensitive.js 里实现一次（bridge.js 不再自己写替换循环）',
    maskRefs >= 3 && ownLoop === false, `TOKEN_MASK=${maskRefs} 次、bridge.js 自有循环=${ownLoop}`);
}

console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} ═══`);
await new Promise((r) => setTimeout(r, 300)); // 避开 libuv UV_HANDLE_CLOSING 断言
process.exit(fail === 0 ? 0 : 1);
