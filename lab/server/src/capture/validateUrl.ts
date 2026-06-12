/**
 * Server-side URL validator for the screencast planner.
 *
 * A planned moment is only captured if its URL actually resolves to a real HTML
 * page. We require: a reachable response with status < 400 AND an HTML-ish
 * content-type. We try a cheap HEAD first and fall back to a ranged GET (many
 * sites reject HEAD with 403/405 but serve GET fine). Everything is bounded by a
 * hard timeout so one slow/hung host can't stall planning.
 *
 * The fetch is injectable (`fetchImpl`) so the logic is unit-tested without
 * network — see planner shaping tests.
 */

export const VALIDATE_TIMEOUT_MS = 8_000;

type FetchFn = typeof fetch;

function isHtmlResponse(status: number, contentType: string | null): boolean {
  if (status >= 400) return false;
  // No content-type → be lenient only for clearly-OK statuses; most real pages
  // DO send one. Treat missing as HTML when 2xx so SPAs behind CDNs still pass.
  if (!contentType) return status >= 200 && status < 300;
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

async function tryOnce(
  url: string,
  method: "HEAD" | "GET",
  fetchImpl: FetchFn,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method,
      redirect: "follow",
      signal: ctrl.signal,
      headers: method === "GET" ? { range: "bytes=0-2047" } : undefined,
    });
    return isHtmlResponse(res.status, res.headers?.get?.("content-type") ?? null);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when `url` resolves to a reachable HTML page. HEAD first, then a ranged
 * GET fallback. Never throws.
 */
export async function validateUrlReachable(
  url: string,
  fetchImpl: FetchFn = fetch,
): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  if (await tryOnce(url, "HEAD", fetchImpl)) return true;
  return tryOnce(url, "GET", fetchImpl);
}
