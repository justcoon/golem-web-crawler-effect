import { Effect, Schema, Redacted } from "effect";
import {
  defineAgent,
  method,
  Http,
} from "@golemcloud/effect-golem";
import { SqlClient } from "effect/unstable/sql";
import { getSql, CrawlerConfig } from "./config.js";
import { FilterType, LinkFilter, groupPrioritizedUrlsByNormalizedDomain } from "./common.js";
import { DomainCrawlerAgent } from "./domain-crawler-agent.js";

export const DomainInfo = Schema.Struct({
  domain: Schema.String,
  pageCount: Schema.Number,
});
export type DomainInfo = Schema.Schema.Type<typeof DomainInfo>;

export const OrchestratorError = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("EmptySeedList"),
  }),
  Schema.Struct({
    _tag: Schema.Literal("InvalidUrl"),
    url: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("DbError"),
    message: Schema.String,
  })
]);
export type OrchestratorError = Schema.Schema.Type<typeof OrchestratorError>;

export const OrchestratorAgent = defineAgent({
  name: "OrchestratorAgent",
  description: "Orchestrates crawls and manages filters",
  mode: "ephemeral",
  config: CrawlerConfig,
  constructorParams: {},
  http: Http.mount("/crawler", { cors: ["*"] }),
  methods: {
    startCrawl: method({
      params: { seeds: Schema.Array(Schema.String) },
      success: Schema.Void,
      error: OrchestratorError,
      http: [Http.post("/start")],
    }),
    getDomains: method({
      params: {},
      success: Schema.Array(DomainInfo),
      error: OrchestratorError,
      http: [Http.get("/domains")],
    }),
    addFilter: method({
      params: { pattern: Schema.String, filterType: FilterType },
      success: Schema.Void,
      error: OrchestratorError,
      http: [Http.post("/filters")],
    }),
    getFilters: method({
      params: {},
      success: Schema.Array(LinkFilter),
      error: OrchestratorError,
      http: [Http.get("/filters")],
    }),
    deleteFilter: method({
      params: { id: Schema.Number },
      success: Schema.Void,
      error: OrchestratorError,
      http: [Http.del("/filters/{id}")],
    }),
  },
}).implement(() =>
  Effect.gen(function* () {
    const sql = yield* getSql;
    const config = yield* CrawlerConfig;

    return {
      startCrawl: ({ seeds }) =>
        Effect.gen(function* () {
          if (seeds.length === 0) {
            return yield* Effect.fail({ _tag: "EmptySeedList" as const });
          }

          for (const s of seeds) {
            try {
              new URL(s);
            } catch {
              return yield* Effect.fail({ _tag: "InvalidUrl" as const, url: s });
            }
          }

          const prefixes = yield* config.urlProcessing.normalizePrefixes;

          const grouped = groupPrioritizedUrlsByNormalizedDomain(seeds, prefixes, (u) => ({
            url: u,
            priority: 10,
          }));

          for (const [domain, prioritizedUrls] of Object.entries(grouped)) {
            const client = yield* DomainCrawlerAgent.client.get({ domainName: domain });
            yield* client.enqueue.trigger({ urls: prioritizedUrls });
          }
        }).pipe(
          Effect.catch((e: any) => {
            if (e && typeof e === "object" && "_tag" in e && (e._tag === "EmptySeedList" || e._tag === "InvalidUrl" || e._tag === "DbError")) {
              return Effect.fail(e);
            }
            return Effect.fail({
              _tag: "DbError" as const,
              message: String(e?.message || e),
            });
          })
        ),

      getDomains: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{ domain: string; count: string }>`
            SELECT domain, COUNT(*) as count FROM page_contents GROUP BY domain ORDER BY domain ASC
          `;
          return rows.map((r) => ({
            domain: r.domain,
            pageCount: parseInt(r.count, 10) || 0,
          }));
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((e: any) =>
            Effect.fail({
              _tag: "DbError" as const,
              message: String(e?.message || e),
            })
          )
        ),

      addFilter: ({ pattern, filterType }) =>
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO link_filters (pattern, filter_type)
            VALUES (${pattern}, ${filterType})
            ON CONFLICT (pattern) DO UPDATE SET filter_type = EXCLUDED.filter_type, is_active = true
          `;
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((e: any) =>
            Effect.fail({
              _tag: "DbError" as const,
              message: String(e?.message || e),
            })
          )
        ),

      getFilters: () =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            id: number;
            pattern: string;
            filter_type: string;
            is_active: boolean;
            created_at: any;
          }>`
            SELECT id, pattern, filter_type, is_active, TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
            FROM link_filters ORDER BY id DESC
          `;
          return rows.map((r) => ({
            id: r.id,
            pattern: r.pattern,
            filterType: r.filter_type as FilterType,
            isActive: r.is_active,
            createdAt: String(r.created_at),
          }));
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((e: any) =>
            Effect.fail({
              _tag: "DbError" as const,
              message: String(e?.message || e),
            })
          )
        ),

      deleteFilter: ({ id }) =>
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM link_filters WHERE id = ${id}
          `;
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catch((e: any) =>
            Effect.fail({
              _tag: "DbError" as const,
              message: String(e?.message || e),
            })
          )
        ),
    };
  })
);
