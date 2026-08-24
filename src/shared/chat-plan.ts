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

export function planChatRequest(question: string, webSearchEnabled: boolean): ChatPlan {
  const text = question.replace(/\s+/g, " ").trim();

  if (arithmetic.test(text)) {
    return {
      action: "I’ll calculate the result directly.",
      useWeb: false,
      enableThinking: false,
      kind: "arithmetic"
    };
  }
  if (translation.test(text)) {
    return {
      action: "I’ll translate the text directly while preserving its meaning and tone.",
      useWeb: false,
      enableThinking: false,
      kind: "translation"
    };
  }
  if (summary.test(text)) {
    return {
      action: "I’ll identify the key points and summarize them concisely.",
      useWeb: false,
      enableThinking: true,
      kind: "summary"
    };
  }
  if (coding.test(text)) {
    return {
      action: "I’ll inspect the technical requirements, implement the solution, and verify the result.",
      useWeb: false,
      enableThinking: true,
      kind: "coding"
    };
  }
  if (creative.test(text)) {
    return {
      action: "I’ll create the requested result and keep it focused on the stated requirements.",
      useWeb: false,
      enableThinking: false,
      kind: "creative"
    };
  }
  if (current.test(text)) {
    return {
      action: "I’ll check current sources and summarize the relevant findings.",
      useWeb: webSearchEnabled,
      enableThinking: true,
      kind: "current"
    };
  }
  return {
    action: "I’ll analyze the request, resolve the key points, and give you a concise answer.",
    useWeb: false,
    enableThinking: true,
    kind: "general"
  };
}
