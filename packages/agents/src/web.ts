const UA = "OpumiaResearch/0.1 (documentary fact-check; +https://example.invalid)";

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Read a page as text: the live page first; when the site refuses or the page is gone, the Internet Archive's
 * most recent copy (many news and company pages block automated readers or have been taken down, and a claim
 * whose source cannot be read cannot be verified). `via` says which copy was read.
 */
/** The text of a PDF (court and company filings, reports): up to 60 pages, read with pdf.js. Null when it is not a readable PDF. */
export async function pdfText(url: string, maxChars = 120_000): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, accept: "application/pdf,*/*" }, redirect: "follow", signal: AbortSignal.timeout(40_000) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 500 || buf.length > 40_000_000 || String.fromCharCode(...buf.slice(0, 5)) !== "%PDF-") return null;
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as { getDocument: (o: { data: Uint8Array; useSystemFonts: boolean; verbosity: number }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }> }> } };
    const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: true, verbosity: 0 }).promise;
    let text = "";
    for (let i = 1; i <= Math.min(doc.numPages, 60) && text.length < maxChars; i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      text += `${c.items.map((x) => x.str ?? "").join(" ").replace(/\s+/g, " ").trim()}\n`;
    }
    return text.trim().length > 200 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}

export async function readPage(url: string, maxChars = 80_000, browser?: (url: string) => Promise<string | null>): Promise<{ text: string; via: "live" | "archive" | "browser" } | null> {
  if (/\.pdf($|[?#])/i.test(url)) {
    const pdf = await pdfText(url, Math.max(maxChars, 120_000));
    if (pdf) return { text: pdf, via: "live" };
  }
  const live = await fetchPageText(url, maxChars, BROWSER_UA);
  if (live && live.length > 600) return { text: live, via: "live" };
  try {
    const r = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { archived_snapshots?: { closest?: { available?: boolean; url?: string } } };
    const snap = j.archived_snapshots?.closest;
    if (snap?.available && snap.url) {
      // "id_" serves the page as it was captured, without the archive's own toolbar.
      const raw = snap.url.replace(/^http:/, "https:").replace(/\/web\/(\d+)\//, "/web/$1id_/");
      const text = await fetchPageText(raw, maxChars, UA);
      if (text && text.length > 600) return { text, via: "archive" };
    }
  } catch {
    /* no archived copy */
  }
  // Last resort: a real browser (the page may need JavaScript, or refuse anything that is not a browser).
  const viaBrowser = browser ? await browser(url).catch(() => null) : null;
  if (viaBrowser && viaBrowser.length > 600) return { text: viaBrowser.slice(0, maxChars), via: "browser" };
  return live ? { text: live, via: "live" } : null;
}

/** Fetch a public page and reduce it to readable text (≤ maxChars). Returns null when unreachable. */
export async function fetchPageText(url: string, maxChars = 80_000, ua: string = UA): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml,text/plain", "accept-language": "en-US,en;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text|html|xml|json/.test(type)) return null;
    const html = await res.text();
    const text = decode(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
    return text.length > 200 ? text.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}
