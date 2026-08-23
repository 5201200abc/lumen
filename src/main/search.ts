export type SearchHit = { title: string; url: string; content: string };

export async function tavilySearch(
  apiKey: string,
  query: string
): Promise<{ digest: string; hits: SearchHit[]; answer: string }> {
  if (!apiKey) throw new Error("未配置 Tavily API Key");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      max_results: 5,
      include_answer: true,
      search_depth: "basic"
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily ${res.status}: ${body.slice(0, 240)}`);
  }
  const data = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const hits: SearchHit[] = (data.results || []).map((hit) => ({
    title: (hit.title || "").trim(),
    url: (hit.url || "").trim(),
    content: (hit.content || "").trim().slice(0, 1200)
  }));
  const parts = [`全网检索（Tavily）：${query}`];
  if (data.answer) parts.push(`摘要：${data.answer.trim()}`);
  hits.forEach((hit, i) => {
    parts.push(`[${i + 1}] ${hit.title}\n${hit.url}\n${hit.content}`);
  });
  if (hits.length === 0 && !data.answer) parts.push(`未检索到与「${query}」相关的网页。`);
  return { digest: parts.join("\n\n"), hits, answer: data.answer || "" };
}
