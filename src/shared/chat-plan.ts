export type ChatPlan = {
  action: string;
  useWeb: boolean;
  enableThinking: boolean;
  kind: "arithmetic" | "translation" | "summary" | "creative" | "coding" | "current" | "general";
};

const arithmetic =
  /(?:\d[\d,\s]*(?:[+\-*/×÷^]|乘以|除以|加上|减去)\s*[\d,.]+|(?:calculate|compute|what is|等于多少|是多少).*\d)/i;
const translation = /(?:translate|translation|翻译|译成|译为)/i;
const summary = /(?:summari[sz]e|summary|概括|总结|摘要)/i;
const coding = /(?:\bcode\b|implement|debug|refactor|function|class|api|svg|html|css|javascript|typescript|python|rust|golang|编程|代码|修复|实现)/i;
const creative = /(?:write|draft|compose|generate|create|story|poem|画|写一|生成|创作)/i;
const current = /(?:latest|recent|current|today|now|news|weather|price|version|release|最近|最新|当前|今天|现在|新闻|天气|价格|版本)/i;

export function planChatRequest(question: string, webSearchEnabled: boolean, language: "zh" | "en" = "en"): ChatPlan {
  const text = question.replace(/\s+/g, " ").trim();
  const isZh = language === "zh" || /[\u4e00-\u9fa5]/.test(text);

  if (arithmetic.test(text)) {
    return {
      action: isZh ? "我将直接计算结果。" : "I’ll calculate the result directly.",
      useWeb: false,
      enableThinking: false,
      kind: "arithmetic"
    };
  }
  if (translation.test(text)) {
    return {
      action: isZh ? "我将直接翻译文本，并保留其原意与语气。" : "I’ll translate the text directly while preserving its meaning and tone.",
      useWeb: false,
      enableThinking: false,
      kind: "translation"
    };
  }
  if (summary.test(text)) {
    return {
      action: isZh ? "我将提炼核心要点并进行简明概括。" : "I’ll identify the key points and summarize them concisely.",
      useWeb: webSearchEnabled,
      enableThinking: true,
      kind: "summary"
    };
  }
  if (coding.test(text)) {
    return {
      action: isZh ? "我将分析技术需求，实现方案并验证结果。" : "I’ll inspect the technical requirements, implement the solution, and verify the result.",
      useWeb: webSearchEnabled,
      enableThinking: true,
      kind: "coding"
    };
  }
  if (creative.test(text)) {
    return {
      action: isZh ? "我将根据要求进行创作并紧扣主题。" : "I’ll create the requested result and keep it focused on the stated requirements.",
      useWeb: false,
      enableThinking: false,
      kind: "creative"
    };
  }
  if (current.test(text)) {
    return {
      action: isZh ? "我将进行深度研究、交叉验证并总结相关要点。" : "I’ll research current sources, cross-check them, and synthesize the findings.",
      useWeb: webSearchEnabled,
      enableThinking: true,
      kind: "current"
    };
  }
  return {
    action: webSearchEnabled
      ? (isZh ? "我将进行多轮检索、全文抓取与交叉验证。" : "I’ll run multi-step research, extract full sources, and cross-check the evidence.")
      : (isZh ? "我将分析需求、梳理要点并为您提供清晰解答。" : "I’ll analyze the request, resolve the key points, and give you a concise answer."),
    useWeb: webSearchEnabled,
    enableThinking: true,
    kind: "general"
  };
}
