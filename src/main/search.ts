export type SearchHit = { title: string; url: string; content: string };
export type ExtractedPage = { title: string; url: string; markdown: string };

export async function tavilySearch(
  apiKey: string,
  query: string,
  options: { maxResults?: number; signal?: AbortSignal } = {}
): Promise<{ digest: string; hits: SearchHit[]; answer: string }> {
  if (!apiKey) throw new Error("未配置 Tavily API");
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      max_results: Math.max(1, Math.min(options.maxResults ?? 5, 10)),
      include_answer: false,
      include_raw_content: false,
      search_depth: "advanced"
    }),
    signal: options.signal
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

export async function tavilyExtract(
  apiKey: string,
  urls: string[],
  options: {
    depth?: "basic" | "advanced";
    titles?: Map<string, string>;
    signal?: AbortSignal;
  } = {}
): Promise<ExtractedPage[]> {
  if (!apiKey) throw new Error("未配置 Tavily API");
  const selected = [...new Set(urls)].slice(0, 20);
  if (!selected.length) return [];
  const res = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      urls: selected,
      extract_depth: options.depth || "advanced",
      format: "markdown",
      include_images: false,
      timeout: options.depth === "basic" ? 15 : 45
    }),
    signal: options.signal
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tavily Extract ${res.status}: ${body.slice(0, 240)}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ url?: string; raw_content?: string }>;
    failed_results?: Array<{ url?: string; error?: string }>;
  };
  const pages = (data.results || []).flatMap((result) => {
    const url = result.url?.trim() || "";
    const markdown = result.raw_content?.trim() || "";
    return url && markdown
      ? [{ title: options.titles?.get(url) || url, url, markdown }]
      : [];
  });
  if (!pages.length) {
    const failure = data.failed_results?.[0];
    throw new Error(failure?.error || "Tavily Extract returned no readable content.");
  }
  return pages;
}
