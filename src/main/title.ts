import { getSettings } from "./store";
import { recordParsedUsage } from "./usage";

function sanitizeTitle(raw: string): string {
  let s = raw.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```[\s\S]*?```/g, "").replace(/\*\*/g, "");
  s = s.replace(/^([#*\-\s]*)(主题|对话主题|标题|Title|Topic)[：:\s]*/i, "");
  s = s.replace(/^[“"「『【(\[]+/, "").replace(/[”"」』】)\]]+$/, "");
  s = s.replace(/[。!！?？;；,\.]$/, "").trim();
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
  return firstLine.slice(0, 16).trim();
}

function containsUrl(value: string): boolean {
  return /(?:https?:\/\/|www\.)\S+/i.test(value);
}

function normalizeGeneratedTitle(title: string, userText: string, isZh: boolean): string {
  const withoutUrls = userText.replace(/(?:https?:\/\/|www\.)\S+/gi, "").trim();
  if (containsUrl(userText) && !withoutUrls) {
    return isZh ? "网页内容分析" : "Web Content Analysis";
  }
  if (
    isZh &&
    /(?:我要|我想|想要|需要|帮我)?(?:买|购买|选购)(?:东西|商品)?(?:[。！!？?])?$/.test(userText.trim()) &&
    /^(?:购买商品|商品购买|买东西)$/.test(title)
  ) {
    return "购买商品需求";
  }
  return title;
}

function smartFallbackTitle(userText: string): string {
  const original = userText.trim().replace(/\s+/g, " ");
  let s = original.replace(/(?:https?:\/\/|www\.)\S+/gi, " ").replace(/\s+/g, " ").trim();
  if (!s) return "网页内容分析";

  const intentRules: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
    [/(?:我要|我想|想要|需要|帮我)?(?:买|购买|选购)([^，。！？,.!?]{0,10})/i, (match) => {
      const item = match[1].replace(/^(?:一些|一个|一件|东西|商品)\s*/i, "").trim();
      return item ? `${item.slice(0, 6)}购买需求` : "购买商品需求";
    }],
    [/(?:翻译|译成|译为)/i, "文本翻译需求"],
    [/(?:总结|概括|摘要|提炼)/i, "内容总结需求"],
    [/(?:搜索|检索|查找|查询|全网|最新|新闻)/i, "信息检索需求"],
    [/(?:推荐|建议|怎么选|哪个好)/i, "方案推荐需求"],
    [/(?:比较|对比|区别|差异)/i, "方案对比分析"],
    [/(?:修复|排查|报错|错误|bug|debug)/i, "问题排查修复"],
    [/(?:安装|配置|部署|启动)/i, "安装配置需求"],
    [/(?:写|创作|生成|制作)(?:一|个|篇|段)?/i, "内容创作需求"],
    [/(?:解释|说明|介绍|是什么|为什么)/i, "概念说明需求"]
  ];
  for (const [pattern, title] of intentRules) {
    const match = s.match(pattern);
    if (match) return typeof title === "function" ? title(match) : title;
  }

  const fillerRegex =
    /^(请帮我写一篇|帮我写一篇|请写一篇|请写一个|请写|写一篇|写一个|写段|查找|搜索|检索|查询|全网查找|全网搜索|关于|怎么|如何|解释|说明|分析|我想|我想写|我想知道|我想了解|能不能|可以帮我|能否|做一个|制作一个|求|简述|介绍一下|设计一个|一篇小说|一篇短文|一篇故事|一篇|一个|小说[，,\s]+|文章[，,\s]+|Can you write an?|Please write an?|Write an?|How to|Help me with|Tell me about)\s*[,，:：、\s]*/i;
  while (fillerRegex.test(s)) {
    s = s.replace(fillerRegex, "").trim();
  }
  s = s.replace(/^[,，:：、\s]+/, "");
  s = s.split(/[,，](?=(?:只|仅|请|不要|需要|要求|字数|长度|回复|回答|输出))/)[0];
  s = s.replace(/^[“"「『【(\[]+/, "").replace(/[”"」』】)\]]+$/, "");
  s = s.replace(/[,，。!！?？;；\s]+$/, "");
  const recentUpdate = s.match(/^(.{2,20}?)\s*(?:官方)?(?:最近|近期|最新|过去).{0,10}?(?:产品|功能|版本)?更新/i);
  if (recentUpdate) s = `${recentUpdate[1].trim()}近期更新`;

  if (s.length > 14) {
    s = s.slice(0, 14).trim();
  }
  return s || "新对话";
}

export async function generateConversationTitle(userText: string, assistantText?: string): Promise<string> {
  const cleanUser = userText.trim().replace(/\s+/g, " ");
  if (!cleanUser) return "新对话";

  const isZh = /[\u4e00-\u9fa5]/.test(cleanUser);
  const cleanAssistant = assistantText ? assistantText.trim().replace(/\s+/g, " ") : "";

  const systemInstruction = isZh
    ? `你是会话标题生成器。${cleanAssistant ? "阅读用户首问和助手回复" : "阅读用户刚提交的首问"}，概括用户真正要完成的任务或需求，而不是复制、截断原句或URL。标题使用4到8个汉字的名词短语。示例：“我要买东西”→“购买商品需求”；“比较两款电脑”→“电脑选购对比”；只有URL时→“网页内容分析”。只输出标题，不要解释、标点、前缀或推理。`
    : `You generate conversation titles. Read ${cleanAssistant ? "the first user request and assistant response" : "the newly submitted first user request"} and name the user's actual task or need. Do not copy or truncate the request or a URL. Use a concise 2 to 5 word noun phrase. A URL by itself becomes "Web Content Analysis". Output only the title, without commentary, punctuation, prefixes, or reasoning.`;

  const userPrompt = isZh
    ? `用户首轮问题：\n${cleanUser.slice(0, 1500)}\n\n${cleanAssistant ? `助手首轮回复：\n${cleanAssistant.slice(0, 800)}\n\n` : ""}请提炼4到8个字的高质量对话标题：`
    : `User's first question:\n${cleanUser.slice(0, 1500)}\n\n${cleanAssistant ? `Assistant's first response:\n${cleanAssistant.slice(0, 800)}\n\n` : ""}Generate a concise 2 to 5 word title:`;

  let timeout: NodeJS.Timeout | undefined;
  try {
    const settings = getSettings();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.llamaApiKey) {
      headers.Authorization = `Bearer ${settings.llamaApiKey}`;
    }

    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(`${settings.llamaUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 48,
        temperature: 0.1,
        reasoning_effort: "none",
        chat_template_kwargs: { enable_thinking: false },
        enable_thinking: false
      })
    });

    if (res.ok) {
      const data = await res.json();
      recordParsedUsage(data.usage, settings.model);
      const choice = data.choices?.[0]?.message;
      let rawTitle = choice?.content?.trim() || "";

      if (rawTitle) {
        const cleaned = sanitizeTitle(rawTitle);
        const normalized = normalizeGeneratedTitle(cleaned, cleanUser, isZh);
        if (
          normalized &&
          normalized.length >= 2 &&
          normalized.length <= 20 &&
          !containsUrl(normalized) &&
          normalized !== cleanUser.slice(0, 16)
        ) {
          return normalized;
        }
      }

      if (choice?.reasoning_content) {
        const reasoning = choice.reasoning_content;
        const matches = [...reasoning.matchAll(/[“"「]([\u4e00-\u9fa5a-zA-Z0-9\s]{2,14})[”"」]/g)];
        if (matches.length > 0) {
          const candidate = sanitizeTitle(matches[matches.length - 1][1]);
          if (candidate && candidate.length >= 2 && candidate.length <= 16 && !containsUrl(candidate)) {
            return candidate;
          }
        }
        const lastLine = reasoning.trim().split(/\n+/).pop() || "";
        const candidate = sanitizeTitle(lastLine);
        if (candidate && candidate.length >= 2 && candidate.length <= 16 && !containsUrl(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // Ignore fetch/parse errors and use fallback
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return smartFallbackTitle(cleanUser);
}
