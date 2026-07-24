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
import { FilterType, LinkFilter, PrioritizedUrl } from "./common.js";

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

function extractContent(baseUrl: string, body: string, activeFilters: readonly { pattern: string; filterType: FilterType }[]): { title: string; extractedLinks: string[] } {
  const titleMatch = body.match(/<title>(.*?)<\/title>/i);
  const title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : "";

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

  return { title, extractedLinks };
}

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

    return {
      fetchAndParse: ({ url }) =>
        Effect.gen(function* () {
          let currentUrl = url;
          let redirectCount = 0;
          const maxRedirects = 5;
          let status = 0;
          let body = "";
          let finalUrl = url;

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
            finalUrl = currentUrl;
            break;
          }

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

          const { title, extractedLinks } = extractContent(finalUrl, body, activeFilters);

          const domain = new URL(finalUrl).hostname;
          yield* sql`
            INSERT INTO page_contents (url, domain, title, http_status, raw_html, extracted_text)
            VALUES (${finalUrl}, ${domain}, ${title}, ${status}, ${body}, ${body})
            ON CONFLICT (url) DO UPDATE SET
              domain = EXCLUDED.domain,
              title = EXCLUDED.title,
              http_status = EXCLUDED.http_status,
              raw_html = EXCLUDED.raw_html,
              extracted_text = EXCLUDED.extracted_text,
              saved_at = CURRENT_TIMESTAMP
          `;

          if (finalUrl !== url) {
            const originalDomain = new URL(url).hostname;
            yield* sql`
              INSERT INTO page_contents (url, domain, title, http_status)
              VALUES (${url}, ${originalDomain}, 'Redirect', ${status})
              ON CONFLICT (url) DO NOTHING
            `;
          }

          return {
            url: finalUrl,
            originalUrl: url,
            title,
            extractedLinks,
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
