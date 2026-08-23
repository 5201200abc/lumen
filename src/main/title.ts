export async function generateConversationTitle(userText: string, assistantText?: string): Promise<string> {
  const cleanUser = userText.trim().replace(/\s+/g, " ");
  if (!cleanUser) return "新对话";

  const prompt = `你是一个精准的对话主题提炼助手。根据以下用户的提问与助手的回复，直接输出一个2到6个字的极简短中文主题词（例如：Claude 身份探讨、视频提示词优化、代码审查、自我介绍、算法分析），绝对不要输出任何多余前缀、标点符号或解释：
用户：${cleanUser.slice(0, 180)}
${assistantText ? `助手：${assistantText.trim().slice(0, 180)}` : ""}
主题：`;

  try {
    const res = await fetch("http://127.0.0.1:18082/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Qwen3.8-27B",
        messages: [
          {
            role: "system",
            content: "你是一个对话主题提炼助手。直接输出2到6个字的主题名称，不要任何前缀、解释或标点。"
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 220,
        temperature: 0.2
      })
    });

    if (res.ok) {
      const data = await res.json();
      const choice = data.choices?.[0]?.message;
      let title = choice?.content?.trim() || "";

      if (title) {
        title = title.replace(/[「」"'"'“”：:。，,\n\r]/g, "").trim();
        title = title.replace(/^(主题|对话主题)[：:\s]*/, "").trim();
        if (title && title.length <= 16) return title;
      }

      if (choice?.reasoning_content) {
        const matches = [...choice.reasoning_content.matchAll(/[“"「]([\u4e00-\u9fa5a-zA-Z0-9\s]{2,12})[”"」]/g)];
        if (matches.length > 0) {
          const candidate = matches[matches.length - 1][1].trim();
          if (candidate && candidate.length <= 16) return candidate;
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // Fallback: smart slice
  return cleanUser.slice(0, 12);
}
