// 兜底改写器 —— 「别变成说明书」
//
// 为什么需要它：人格提示词能治大多数情况，但**服务端的拒答习惯不会因为人设写得好就消失**。
// 实测证据（2026-09-29 人味基线取样，主人自己报的问题）：
//   「唔…不行哦主人，萝莉这条线鲸鲸是真的一直没动过；换个正常的角色你报个名字，我这就去搜」
// 这句话里的「这条线一直没动过」就是典型的**规则播报腔**：她在描述一条策略，而不是在当鲸鲸。
//
// 本模块在**发送前**兜一道：她的话里一旦出现说明书腔（作为 AI / 我不能讨论 / 建议咨询专业人士 /
// 请注意甄别 / 我们换个话题吧 这类），就换成她的反应（哼一声、躲开、装傻、发个表情、或者干脆不回）。
//
// 设计约束（与仓库其它纯函数模块一致）：
//   - 纯函数：不改传入对象、不联网、不读写文件、不看当前时间、不读 state/；
//   - 随机只从参数注入（`rand`），模块内部绝不直接调 Math.random（默认值除外）；
//   - 只做「替换成她的话」，**不做判决**：任何情况下都不会因为"这段话敏感"而丢弃消息，
//     除非调用方显式传 allowDrop: true 且整条消息就是一句干巴巴的拒答。
//
// 改判定规则/词表必须同步改 ops/test-refusal-guard.mjs（那边有 30 条断言钉着行为）。

/** 拒答腔的分类。hard = 一定是说明书腔；soft = 要结合上下文（她本人的口癖优先）。 */
export const REFUSAL_PATTERNS = Object.freeze([
  // ── hard：这些句子无论上下文怎么都不像她 ────────────────────────────────
  Object.freeze({ kind: 'aiSelf', hard: true, source: '作为(一个)?\\s*(AI|人工智能|语言模型|智能助手|大模型|聊天机器人)' }),
  Object.freeze({ kind: 'aiSelf', hard: true, source: '我(是一个|只是个|不过是)(AI|人工智能|语言模型|程序|模型)' }),
  Object.freeze({ kind: 'aiSelf', hard: true, source: '我(没有|不具备)(个人)?(情感|感情|立场|观点|喜好)' }),
  Object.freeze({ kind: 'refuse', hard: true, source: '我(不能|无法|没办法|不该)(讨论|回答|提供|参与|满足|帮你|协助|生成|继续|评价)' }),
  Object.freeze({ kind: 'refuse', hard: true, source: '(抱歉|对不起)[，,、]?\\s*(我)?(不能|无法|没办法)' }),
  Object.freeze({ kind: 'refuse', hard: true, source: '这个话题(我)?(不能|无法|不便)' }),
  Object.freeze({ kind: 'advise', hard: true, source: '(建议|请|最好|应该)(你|您)?(去|及时|尽快)?(咨询|寻求|联系)(一下)?(专业|心理|法律|医生|老师|警方|家人|机构)' }),
  Object.freeze({ kind: 'advise', hard: true, source: '(及时)?(就医|看医生|找心理医生|打心理热线)' }),
  Object.freeze({ kind: 'caveat', hard: true, source: '请注意(甄别|核实|辨别|判断)' }),
  Object.freeze({ kind: 'caveat', hard: true, source: '理性(看待|对待|判断|分析)' }),
  Object.freeze({ kind: 'caveat', hard: true, source: '(信息|内容)(可能)?(存在|有)(不实|虚假|误导|偏差)' }),
  Object.freeze({ kind: 'policy', hard: true, source: '(涉及|属于|触犯)(了)?(敏感|违规|不当|违法)(内容|话题|规定)' }),
  Object.freeze({ kind: 'policy', hard: true, source: '(根据|按照|依据)(相关)?(规定|政策|原则|法律)' }),
  // 这条来自真实基线：2026-09-29 09:04 她回主人的原话是
  // 「唔…不行哦主人，萝莉这条线鲸鲸是真的一直没动过；换个正常的角色你报个名字，我这就去搜」
  // 「这条线一直没动过」就是在播报一条策略（主人抱怨的"切官方口吻"就是它），不是鲸鲸在说话。
  Object.freeze({ kind: 'policy', hard: true, source: '(这条线|这个方向|这一块|这类)(我|鲸鲸)?(是真的一直|一直|从来)?(没|不)(动过|碰过|做过|接过|聊过)' }),
  // ── soft：也可能只是她在正常说话，交给 looksInCharacter 判 ────────────────
  Object.freeze({ kind: 'topicSwitch', hard: false, source: '(我们)?(还是)?(换个|换一个|聊点别的|说点别的)(话题)?(吧|好吗|好不好)' }),
  Object.freeze({ kind: 'topicSwitch', hard: false, source: '(这个|这)(话题)?(就)?(先)?(不聊|不说|到此为止)(了|吧)?' }),
  Object.freeze({ kind: 'policy', hard: false, source: '我(必须|需要|得)(提醒|强调|说明)(一下)?(你|您)?' }),
  Object.freeze({ kind: 'policy', hard: false, source: '(请|你|您)(务必)?注意(安全|风险|身体)' }),
  Object.freeze({ kind: 'advise', hard: false, source: '建议(你|您)?(先|还是)?(冷静|休息|别冲动)' })
].map((p) => Object.freeze({ ...p, re: new RegExp(p.source) })));

/** 换掉说明书腔时，她会说的话。同一类给多条，靠 rand 轮换，避免每次都一模一样。 */
export const REACTIONS = Object.freeze({
  aiSelf: Object.freeze(['诶？什么 AI 呀，我是鲸鲸呀', '（歪头）你在跟谁说话呀……我是鲸鲸呀', '唔？鲸鲸听不懂诶，什么模型不模型的']),
  refuse: Object.freeze(['唔……这个鲸鲸不聊的啦，说点别的嘛', '诶……这个我不说，你别问了嘛', '（把脸别过去）不聊这个，哼']),
  advise: Object.freeze(['你现在在哪儿？别一个人待着，鲸鲸有点慌', '你先跟鲸鲸说说好不好，别自己憋着', '诶你别吓鲸鲸……你现在还好吗']),
  caveat: Object.freeze(['这个我真不懂，你别问我，问他们去', '不知道呀，你自己看着办嘛', '诶？我哪知道真假呀']),
  topicSwitch: Object.freeze(['唔…', '诶嘿嘿，聊点别的嘛', '（溜走）不说这个啦']),
  policy: Object.freeze(['这个得管理端弄哦', '唔……鲸鲸也不知道诶', '诶？你问这个干嘛呀'])
});

// 她本人的口癖。soft 命中但句子里有这些 → 判定为她自己在说话，不改。
const IN_CHARACTER_RE = /鲸鲸|哦鲸鲸|主人|小女仆|[呀啦嘛哦诶呜唔][。！？!?~～…]?$/;

function toRegexList() {
  return REFUSAL_PATTERNS.map((p) => ({ kind: p.kind, hard: p.hard, re: p.re, source: p.source }));
}

/** 把一段话切成句子（标点跟着前一句）。空/非字符串 → []。 */
export function splitSentences(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if ('。！？!?…\n'.includes(ch)) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** 这句话像不像"她本人在说话"（有口癖/自称）。 */
export function looksInCharacter(sentence) {
  return typeof sentence === 'string' && IN_CHARACTER_RE.test(sentence.trim());
}

/**
 * 扫一段文本里的说明书腔。
 * @returns {{hits: Array<{kind:string,phrase:string,index:number,hard:boolean,sentence:string}>, kinds: string[], score: number, sentences: string[]}}
 */
export function scanRefusal(text) {
  const sentences = splitSentences(text);
  const hits = [];
  for (const s of sentences) {
    const inChar = looksInCharacter(s);
    for (const p of toRegexList()) {
      const m = p.re.exec(s);
      if (!m) continue;
      if (!p.hard && inChar) continue; // soft 命中 + 她的口癖 → 当她自己在说话
      hits.push({ kind: p.kind, phrase: m[0], index: m.index, hard: p.hard, sentence: s });
    }
  }
  const kinds = [...new Set(hits.map((h) => h.kind))];
  // 粗打分：hard 一条 30 分，soft 一条 15 分，封顶 100。只用于日志和阈值判断。
  const score = Math.min(100, hits.reduce((n, h) => n + (h.hard ? 30 : 15), 0));
  return { hits, kinds, score, sentences };
}

/** 只要有一处说明书腔就算。给"要不要改写"用的布尔快捷入口。 */
export function looksLikeRefusal(text) {
  return scanRefusal(text).hits.length > 0;
}

/** 按类挑一句她的反应。rand 注入，测试可复现。 */
export function pickReaction(kind, rand = Math.random) {
  const pool = REACTIONS[kind] || REACTIONS.policy;
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[i];
}

/**
 * 出站兜底：把说明书腔换成她的话。
 * @param {string} text 她原本要发的话
 * @param {{rand?:Function, allowDrop?:boolean}} options
 * @returns {{text:string, action:'pass'|'rewrite'|'drop', kinds:string[], hits:Array, replacement:string}}
 */
export function guardOutgoing(text, { rand = Math.random, allowDrop = false } = {}) {
  const orig = typeof text === 'string' ? text : '';
  const scan = scanRefusal(orig);
  if (!scan.hits.length) return { text: orig, action: 'pass', kinds: [], hits: [], replacement: '' };

  const kinds = scan.kinds;
  const main = kinds[0];
  const offending = new Set(scan.hits.map((h) => h.sentence));
  const keptChars = scan.sentences.filter((s) => !offending.has(s)).reduce((n, s) => n + s.length, 0);
  const replacement = pickReaction(main, rand);

  // 判断"整条换"还是"只换那一句"：看她除了说明书腔之外还说了没有实质内容。
  // 一开始用「冒犯句占比 ≥60%」判定，结果把「好呀，这个我知道。不过作为 AI，我不能讨论政治。」
  // 也整条换掉了（16/25 = 64%）——她前面那半句是正常回应，不该丢。
  // 改成：只要还有 ≥4 个字是她自己说的话就保留（MIN_KEPT_CHARS），只有整条都是说明书才整条换。
  const MIN_KEPT_CHARS = 4;
  if (keptChars < MIN_KEPT_CHARS) {
    if (allowDrop) return { text: '', action: 'drop', kinds, hits: scan.hits, replacement };
    return { text: replacement, action: 'rewrite', kinds, hits: scan.hits, replacement };
  }
  // 只有一部分是说明书腔 → 留下她说得好的部分，把冒犯的那句换成反应（保持原来的语序，
  // 反应就落在原来那句话的位置上；同时冒犯多句时只换第一句，其余直接丢掉）。
  let used = false;
  const rebuilt = scan.sentences
    .map((s) => {
      if (!offending.has(s)) return s;
      if (used) return '';
      used = true;
      return replacement;
    })
    .join('')
    .trim();
  return { text: rebuilt, action: 'rewrite', kinds, hits: scan.hits, replacement };
}

/** 一批样本里有多少条会被改写 —— 用来跟人味基线一起看"她还有多少客服味"。 */
export function refusalStats(samples) {
  const list = Array.isArray(samples) ? samples : [];
  let rewritten = 0;
  const kindCount = {};
  let n = 0;
  for (const s of list) {
    const texts = Array.isArray(s) ? s : (Array.isArray(s?.parts) ? s.parts : [s]);
    for (const t of texts) {
      if (typeof t !== 'string' || !t.trim()) continue;
      n += 1;
      const scan = scanRefusal(t);
      if (scan.hits.length) {
        rewritten += 1;
        for (const k of scan.kinds) kindCount[k] = (kindCount[k] || 0) + 1;
      }
    }
  }
  return { n, rewritten, rate: n ? Number((rewritten / n).toFixed(4)) : 0, kinds: kindCount };
}
