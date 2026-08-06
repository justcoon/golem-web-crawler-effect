import { Effect, Schema } from "effect";
import {
  defineAgent,
  method,
} from "@golemcloud/effect-golem";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { getSql, CrawlerConfig } from "./config.js";
import { FilterType, LinkFilter, PrioritizedUrl, normalizeDomain, normalizeUrlDomain } from "./common.js";

export const FetchResult = Schema.Struct({
  url: Schema.String,
  originalUrl: Schema.String,
  title: Schema.String,
  extractedLinks: Schema.Array(Schema.String),
  status: Schema.Number,
});
export type FetchResult = Schema.Schema.Type<typeof FetchResult>;

export const FetcherError = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("InvalidUrl"),
    url: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("RobotsDisallowed"),
    url: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("HttpFetchFailed"),
    url: Schema.String,
    statusCode: Schema.Number,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("DbError"),
    message: Schema.String,
  })
]);
export type FetcherError = Schema.Schema.Type<typeof FetcherError>;

function resolveUrl(baseUrl: string, relative: string): string | null {
  try {
    return new URL(relative, baseUrl).toString();
  } catch {
    return null;
  }
}

function isFiltered(urlStr: string, filters: readonly { pattern: string; filterType: FilterType }[]): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const urlLower = urlStr.toLowerCase();

    for (const filter of filters) {
      const patternLower = filter.pattern.toLowerCase();
      switch (filter.filterType) {
        case "domain_blacklist":
          if (host === patternLower || host.endsWith(`.${patternLower}`)) {
            return true;
          }
          break;
        case "keyword":
          if (urlLower.includes(patternLower)) {
            return true;
          }
          break;
        case "url_regex":
          try {
            const re = new RegExp(filter.pattern);
            if (re.test(urlStr)) {
              return true;
            }
          } catch {
            // ignore
          }
          break;
        case "extension":
          if (path.endsWith(patternLower)) {
            return true;
          }
          break;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function extractTextFromHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer|nav)>/gi, "\n\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/td>/gi, " ");

  text = text.replace(/<[^>]+>/g, " ");

  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return text
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function extractContent(baseUrl: string, body: string, activeFilters: readonly { pattern: string; filterType: FilterType }[]): { title: string; extractedText: string; extractedLinks: string[]; canonicalUrl?: string } {
  const titleMatch = body.match(/<title>(.*?)<\/title>/i);
  const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : "";

  let canonicalUrl: string | undefined = undefined;
  const canonicalMatch = body.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ||
                         body.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  if (canonicalMatch && canonicalMatch[1]) {
    const resolved = resolveUrl(baseUrl, canonicalMatch[1].trim());
    if (resolved) canonicalUrl = resolved;
  }
  if (!canonicalUrl) {
    const ogMatch = body.match(/<meta\s+[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i) ||
                    body.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["']/i);
    if (ogMatch && ogMatch[1]) {
      const resolved = resolveUrl(baseUrl, ogMatch[1].trim());
      if (resolved) canonicalUrl = resolved;
    }
  }

  const baseMatch = body.match(/<base\s+[^>]*href\s*=\s*["']([^"']+)["']/i);
  let resolvedBaseUrl = baseUrl;
  if (baseMatch && baseMatch[1]) {
    const baseHref = baseMatch[1].trim();
    const resolvedBase = resolveUrl(baseUrl, baseHref);
    if (resolvedBase) {
      resolvedBaseUrl = resolvedBase;
    }
  }

  const linkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
  const extractedLinks: string[] = [];
  let match;
  while ((match = linkRegex.exec(body)) !== null) {
    if (match && match[1]) {
      const link = match[1].trim();
      if (
        link &&
        !link.startsWith("#") &&
        !link.startsWith("javascript:") &&
        !link.startsWith("mailto:") &&
        !link.startsWith("tel:")
      ) {
        const resolved = resolveUrl(resolvedBaseUrl, link);
        if (resolved) {
          try {
            const parsed = new URL(resolved);
            const scheme = parsed.protocol;
            if ((scheme === "http:" || scheme === "https:") && !isFiltered(resolved, activeFilters)) {
              extractedLinks.push(resolved);
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  const extractedText = extractTextFromHtml(body);

  return { title, extractedText, extractedLinks, canonicalUrl };
}

const fetchSingleUrl = (targetUrl: string) =>
  Effect.gen(function* () {
    let currentUrl = targetUrl;
    let redirectCount = 0;
    const maxRedirects = 5;
    let status = 0;
    let body = "";
    let finalUrl = targetUrl;

    while (true) {
      const request = HttpClientRequest.get(currentUrl).pipe(
        HttpClientRequest.setHeader("Accept", "text/html"),
        HttpClientRequest.setHeader("User-Agent", "golem-crawler/1.0")
      );

      const response = yield* HttpClient.execute(request).pipe(
        Effect.provide(FetchHttpClient.layer)
      );
      status = response.status;

      if (status >= 300 && status <= 399) {
        if (redirectCount >= maxRedirects) {
          return yield* Effect.fail({
            _tag: "HttpFetchFailed" as const,
            url: currentUrl,
            statusCode: status,
            message: "Too many redirects",
          });
        }
        const location = response.headers["location"];
        if (location) {
          const nextUrl = resolveUrl(currentUrl, location);
          if (!nextUrl) {
            return yield* Effect.fail({
              _tag: "InvalidUrl" as const,
              url: location,
              reason: "Invalid redirect location",
            });
          }
          currentUrl = nextUrl;
          redirectCount++;
          continue;
        }
      }

      body = yield* response.text;
      const respUrl = (response as any).url || (response as any).source?.url;
      if (respUrl && typeof respUrl === "string" && respUrl.length > 0) {
        finalUrl = respUrl;
      } else {
        finalUrl = currentUrl;
      }
      break;
    }

    return { body, finalUrl, status };
  });

const fetchPageContent = (url: string) =>
  Effect.gen(function* () {
    if (url.startsWith("http://")) {
      const httpsUrl = "https://" + url.slice("http://".length);
      const httpsAttempt = yield* fetchSingleUrl(httpsUrl).pipe(
        Effect.map((res) => ({ success: true as const, res })),
        Effect.catch(() => Effect.succeed({ success: false as const, res: null }))
      );
      if (httpsAttempt.success && httpsAttempt.res && httpsAttempt.res.status >= 200 && httpsAttempt.res.status < 300) {
        return httpsAttempt.res;
      }
    }
    return yield* fetchSingleUrl(url);
  });

export const FetcherAgent = defineAgent({
  name: "FetcherAgent",
  description: "Fetches and parses individual web pages",
  mode: "ephemeral",
  config: CrawlerConfig,
  constructorParams: {},
  methods: {
    fetchAndParse: method({
      params: { url: Schema.String },
      success: FetchResult,
      error: FetcherError,
    }),
  },
}).implement(() =>
  Effect.gen(function* () {
    const sql = yield* getSql;
    const config = yield* CrawlerConfig;

    return {
      fetchAndParse: ({ url }) =>
        Effect.gen(function* () {
          const { status, body, finalUrl } = yield* fetchPageContent(url);

          const activeFilters = yield* sql<{ pattern: string; filter_type: string }>`
            SELECT pattern, filter_type FROM link_filters WHERE is_active = true
          `.pipe(
            Effect.map((rows) =>
              rows.map((r) => ({
                pattern: r.pattern,
                filterType: r.filter_type as FilterType,
              }))
            )
          );

          const prefixes = yield* config.urlProcessing.normalizePrefixes;
          let normalizedFinalUrl = normalizeUrlDomain(finalUrl, prefixes);
          const normalizedUrl = normalizeUrlDomain(url, prefixes);

          const urlStr = normalizedUrl.toString();
          const { title, extractedText, extractedLinks, canonicalUrl } = extractContent(normalizedFinalUrl.toString(), body, activeFilters);

          if (canonicalUrl) {
            try {
              normalizedFinalUrl = normalizeUrlDomain(canonicalUrl, prefixes);
            } catch {
              // ignore invalid canonical URL
            }
          }

          const domain = normalizedFinalUrl.hostname;
          const finalUrlStr = normalizedFinalUrl.toString();

          yield* sql`
            INSERT INTO page_contents (url, domain, title, http_status, raw_html, extracted_text)
            VALUES (${finalUrlStr}, ${domain}, ${title}, ${status}, ${body}, ${extractedText})
            ON CONFLICT (url) DO UPDATE SET
              domain = EXCLUDED.domain,
              title = EXCLUDED.title,
              http_status = EXCLUDED.http_status,
              raw_html = EXCLUDED.raw_html,
              extracted_text = EXCLUDED.extracted_text,
              saved_at = CURRENT_TIMESTAMP
          `;

          if (finalUrlStr !== urlStr) {
            yield* sql`
              INSERT INTO url_redirects (from_url, to_url)
              VALUES (${urlStr}, ${finalUrlStr})
              ON CONFLICT (from_url) DO UPDATE SET to_url = EXCLUDED.to_url
            `;
          }

          const normalizedLinks = extractedLinks.map((link) => normalizeUrlDomain(link, prefixes).toString());

          return {
            url: finalUrlStr,
            originalUrl: urlStr,
            title,
            extractedLinks: normalizedLinks,
            status,
          };
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((e: any) => {
            if (
              e &&
              typeof e === "object" &&
              "_tag" in e &&
              (e._tag === "InvalidUrl" ||
                e._tag === "RobotsDisallowed" ||
                e._tag === "HttpFetchFailed" ||
                e._tag === "DbError")
            ) {
              return Effect.fail(e);
            }
            return Effect.fail({
              _tag: "DbError" as const,
              message: String(e?.message || e),
            });
          })
        ),
    };
  })
);
