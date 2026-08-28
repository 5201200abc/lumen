export type ScrapedPage = {
  title: string;
  url: string;
  markdown: string;
};

function scrapeEndpoints(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v[12]$/i.test(base)
    ? [`${base}/scrape`]
    : [`${base}/v2/scrape`, `${base}/v1/scrape`];
}

export async function firecrawlScrape(
  baseUrl: string,
  apiKey: string,
  url: string,
  signal?: AbortSignal
): Promise<ScrapedPage> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const options = {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    onlyCleanContent: true,
    parsers: ["pdf"],
    waitFor: 500,
    timeout: 60_000,
    removeBase64Images: true,
    blockAds: true
  };
  let res: Response | undefined;
  for (const endpoint of scrapeEndpoints(baseUrl)) {
    const body = JSON.stringify(
      endpoint.includes("/v1/")
        ? { ...options, onlyCleanContent: undefined }
        : options
    );
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(75_000)])
        : AbortSignal.timeout(75_000)
    });
    if (res.status !== 404) break;
  }
  if (!res) throw new Error("Firecrawl request could not be started");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firecrawl ${res.status}: ${body.slice(0, 240)}`);
  }
  const result = (await res.json()) as {
    success?: boolean;
    error?: string;
    data?: {
      markdown?: string;
      metadata?: { title?: string; sourceURL?: string; url?: string };
    };
  };
  const markdown = result.data?.markdown?.trim() || "";
  if (!result.success || !markdown) {
    throw new Error(result.error || "Firecrawl returned no readable content");
  }
  return {
    title: result.data?.metadata?.title?.trim() || url,
    url: result.data?.metadata?.sourceURL || result.data?.metadata?.url || url,
    markdown
  };
}
