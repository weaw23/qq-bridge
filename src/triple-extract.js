// 三元组抽取（从她写下来的 facts 句子里抽「主体 + 谓词 + 客体」）
//
// 为什么单独成一个模块：这是**边界逻辑**（输入是自由文本，输出是结构化槽位，
// 判错的代价是"她记错人"），必须能离线跑回归，不能埋在 11000 行的 bridge.js 里靠线上观察。
// 约定与其它纯函数模块一致：不看钟、不读盘、不随机、不 import 任何东西。
//
// 抽不准的边界（刻意保守，宁可漏也不要错）：
//   · 只认下表里那几种中文写法，别的句式一律不抽
//   · 一句话只取**最匹配的那一条**谓词（"她喜欢猫也喜欢狗"只留"喜欢猫"，不拆成两条错关系）
//   · 问句 / 超长句 / 带"不知道、也许"的不确定句一律不抽
//   · 主体 ≤14 字、客体 ≤30 字，超了弃用（超长基本是把整句话吞进来了）

export const EXTRACT_VERSION = 1;

// 谓词表：re 的捕获组依次是（主体, 客体）。**顺序即优先级（先匹配到的先赢）**，
// 所以 讨厌 必须排在 喜欢 前面：「不喜欢香菜」里含「喜欢」，反过来会抽出
// 「阿伟不 + 喜欢 + 香菜」——主体带个"不"，读起来正好是反的意思（实测踩到过）。
export const TRIPLE_PATTERNS = Object.freeze([
  Object.freeze({ predicate: '最喜欢', re: /^(.{1,14}?)(?:最喜欢|最爱)(.{1,30})$/ }),
  Object.freeze({ predicate: '讨厌', re: /^(.{1,14}?)(?:最讨厌|讨厌|不喜欢|不爱)(.{1,30})$/ }),
  Object.freeze({ predicate: '喜欢', re: /^(.{1,14}?)(?:超级喜欢|很喜欢|喜欢|爱)(.{1,30})$/ }),
  Object.freeze({ predicate: '生日', re: /^(.{1,14}?)(?:的)?生日(?:是|在|：|:)?(.{1,30})$/ }),
  Object.freeze({ predicate: '住在', re: /^(.{1,14}?)(?:住在|家住|来自)(.{1,30})$/ }),
  Object.freeze({ predicate: '名字', re: /^(.{1,14}?)(?:的名字是|叫做|叫)(.{1,20})$/ }),
  Object.freeze({ predicate: '在…工作', re: /^(.{1,14}?)在(.{1,20}?)(?:工作|上班|读书|上学)$/ }),
]);

export const EXTRACT_LIMITS = Object.freeze({
  minLength: 4,     // 比这短的基本是语气词（"好的呀"）
  maxLength: 40,    // 40 字以上是叙述句（"今天小满跟我聊了很久他说他最喜欢…"），抽出来一定是错关系
  maxSubjectLength: 14,
  maxObjectLength: 30,
});

const UNCERTAIN = /不知道|记不清|可能吧|也许|大概|好像|不确定/;
const LEADING_NOISE = /^[的地得和跟与]/;
// 主体里出现这些，说明整句是叙述而不是「谁 → 喜欢 → 什么」的陈述：
// 实测「今天小满跟我聊了很久他说他最喜欢草莓蛋糕…」会把主体抽成「今天小满跟我聊了很久他说他」。
const NARRATIVE_SUBJECT = /了|说|讲|聊|问|告诉|提起|觉得|认为|然后|但是|因为|所以|如果|虽然/;
const NEGATIVE_TAIL = /[不没别未]$/;

/**
 * 从一句话里抽三元组。返回 `[{ subject, predicate, object }]`，抽不到就是空数组（绝不抛）。
 * 非字符串一律当空处理 —— 上游是 LLM 生成再落库的文本，脏数据不值得让调用方 try。
 * （数组也会被 String() 拍平成一个看起来很像事实的句子，所以这里必须显式挡掉。）
 */
export function extractTriples(content) {
  if (typeof content !== 'string') return [];
  const text = normalize(content);
  if (text.length < EXTRACT_LIMITS.minLength || text.length > EXTRACT_LIMITS.maxLength) return [];
  if (text.includes('?') || text.includes('？')) return [];   // 问句不是事实
  if (UNCERTAIN.test(text)) return [];                        // 她自己都不确定的，不该变成记忆
  for (const { predicate, re } of TRIPLE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const subject = clean(m[1]);
    const object = cleanObject(m[2]);
    if (!subject || !object || subject === object) continue;
    if (subject.length > EXTRACT_LIMITS.maxSubjectLength) continue;
    if (object.length > EXTRACT_LIMITS.maxObjectLength) continue;
    if (NARRATIVE_SUBJECT.test(subject)) continue;
    if (NEGATIVE_TAIL.test(subject)) continue;                // 「主人不 + 喜欢」这种反向主体
    return [{ subject, predicate, object }];                  // 一句话只出一条：避免拆出两条错关系
  }
  return [];
}

/** 归一化：去掉所有空白（中文事实句里的空格基本都是排版噪声）与句末标点。 */
export function normalize(content) {
  return String(content ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[。！!～~,，、；;]+$/, '');
}

function clean(part) {
  return String(part ?? '')
    .replace(LEADING_NOISE, '')
    .replace(/[。！!～~,，、；;]+$/, '')
    .trim();
}

// 客体的清洗比主体多一步：剥掉开头的系动词/结构助词。「她最喜欢的是芒果」里
// 客体捕获到的是「是芒果」，「芒果」才是值 —— 留着「是」会让同一件事抽成两条。
function cleanObject(part) {
  return clean(part)
    .replace(/^[的地得]+/, '')
    .replace(/^是/, '')
    .trim();
}

/** 把三元组还原成人读的一句话（召回注入与日志都用它，保证两处措辞一致）。 */
export function renderTriple(triple) {
  if (!triple || typeof triple !== 'object') return '';
  const stale = Number(triple.validToMs) > 0 ? '（已作废）' : '';
  return `${String(triple.subject ?? '')}${String(triple.predicate ?? '')}${String(triple.object ?? '')}${stale}`;
}
