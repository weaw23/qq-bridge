// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
// 拦截本机路径/凭据特征；凭据关键词需带赋值关系才判定，避免误伤正常聊天。
// UNC 的主机/共享名之间只有一个反斜杠；JSON 键名可能带引号。
// 这是内容审计的启发式规则，不能代替会话权限控制或对已知令牌的精确拦截。
export const SENSITIVE_RE = /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;

// 打码占位符：正好三个字符，恰好卡在 SENSITIVE_RE 关键词规则要求的「赋值后至少 3 个字符」
// 的边界上。所以审计副本必须把占位符抹掉再判，否则 `token: ***` 会被自己的占位符二次命中。
export const TOKEN_MASK = '***';

// 把文本里出现的已知令牌全部换成占位符；返回替换后的文本与是否真的打到了码。
// 这是**所有**出站文本的第 1 道防线（sendToQQ 里调用），MCP 侧发送、审计、审计副本共用它，
// 避免 `'***'` 字面量与替换逻辑散落在多处。
export function maskTokens(text, tokens) {
  let s = String(text ?? '');
  let masked = false;
  for (const t of tokens ?? []) {
    if (t && s.includes(t)) { s = s.split(t).join(TOKEN_MASK); masked = true; }
  }
  return { text: s, masked };
}

// 出站审计的唯一判据：**令牌先打码，再审计**。
//
// 为什么令牌不拦而要放行：令牌本来就不该出现在出站文本里，而所有发送路径在真正出站前
// 都已经打码，所以「命中令牌就整条拦掉」除了把整条回复吃掉、再往会话里丢一条 ⚠️ 之外
// 没有任何额外保护；而触发它的场景极其日常 —— 她把 wake-config 调用连同
// `x-agent-token: <令牌>` 一起复述出来（线上真实发生过三次）。
// 路径 / 真实凭据关键词（SENSITIVE_RE）的拦截行为**完全不变**：它们不是「已经安全」的内容，
// 打码也救不了，仍然整条拦。
//
// forAudit 是抹掉占位符之后的副本 —— 必须抹，否则占位符自己就会命中关键词规则。
export function sensitiveVerdict(text, tokens) {
  const { text: maskedText, masked } = maskTokens(text, tokens);
  const forAudit = masked ? maskedText.split(TOKEN_MASK).join('') : maskedText;
  return { text: maskedText, masked, forAudit, blocked: SENSITIVE_RE.test(forAudit) };
}
