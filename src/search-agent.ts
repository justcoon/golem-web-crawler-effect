import { Effect, Schema } from "effect";
import {
  defineAgent,
  method,
  Http,
} from "@golemcloud/effect-golem";
import { SqlClient } from "effect/unstable/sql";
import { getSql, CrawlerConfig } from "./config.js";

export const SearchResultPage = Schema.Struct({
  url: Schema.String,
  title: Schema.Union([Schema.Null, Schema.Undefined, Schema.String]),
  domain: Schema.String,
  httpStatus: Schema.Number,
  savedAt: Schema.String,
});
export type SearchResultPage = Schema.Schema.Type<typeof SearchResultPage>;

export const SearchAgent = defineAgent({
  name: "SearchAgent",
  description: "Queries crawled pages using full-text search",
  mode: "ephemeral",
  config: CrawlerConfig,
  constructorParams: {},
  http: Http.mount("/search", { cors: ["*"] }),
  methods: {
    search: method({
      params: { query: Schema.String },
      success: Schema.Array(SearchResultPage),
      error: Schema.String,
      http: [Http.get("/?query={query}")],
    }),
  },
}).implement(() =>
  Effect.gen(function* () {
    const sql = yield* getSql;

    return {
      search: ({ query }) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            url: string;
            domain: string;
            title: string | null;
            http_status: number;
            saved_at: any;
          }>`
            SELECT url, domain, title, http_status, TO_CHAR(saved_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS saved_at
            FROM page_contents
            WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(extracted_text, ''))
                  @@ plainto_tsquery('english', ${query})
            ORDER BY ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(extracted_text, '')), plainto_tsquery('english', ${query})) DESC
            LIMIT 50
          `;

          return rows.map((r) => ({
            url: r.url,
            domain: r.domain,
            title: r.title ?? undefined,
            httpStatus: r.http_status,
            savedAt: String(r.saved_at),
          }));
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((e: any) =>
            Effect.fail(`Database search query failed: ${e?.message || e}`)
          )
        ),
    };
  })
);
