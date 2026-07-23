import { Effect, Ref, Schema, Redacted } from "effect";
import {
  defineAgent,
  method,
  Snapshot,
} from "@golemcloud/effect-golem";
import { HttpClient } from "effect/unstable/http";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { getSql, CrawlerConfig } from "./config.js";
import {
  DomainState,
  PrioritizedUrl,
  CrossDomainPolicy,
  isSubdomain,
  normalizeDomain,
  groupPrioritizedUrlsByNormalizedDomain,
} from "./common.js";
import { FetcherAgent } from "./fetcher-agent.js";

// Parse robots.txt content to return disallowed prefixes and crawl delay
function parseRobotsTxt(content: string): { disallowed: string[]; crawlDelay: number | null } {
  const disallowed: string[] = [];
  let crawlDelay: number | null = null;
  let inRelevantAgent = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const val = partsVal(trimmed, colonIdx);

    if (key === "user-agent") {
      const agent = val.toLowerCase();
      inRelevantAgent = agent === "*" || agent === "golem";
    } else if (inRelevantAgent) {
      if (key === "disallow") {
        if (val) {
          disallowed.push(val);
        }
      } else if (key === "crawl-delay") {
        const secs = parseFloat(val);
        if (!isNaN(secs)) {
          crawlDelay = secs * 1000;
        }
      }
    }
  }

  return { disallowed, crawlDelay };
}

function partsVal(trimmed: string, colonIdx: number): string {
  const segment = trimmed.slice(colonIdx + 1);
  return segment ? segment.trim() : "";
}

// Fetch robots.txt using HttpClient
const fetchRobotsTxt = (domain: string) =>
  Effect.gen(function* () {
    const robotsUrl = `https://${domain}/robots.txt`;
    const response = yield* HttpClient.execute(HttpClientRequest.get(robotsUrl)).pipe(
      Effect.provide(FetchHttpClient.layer)
    );
    if (response.status === 200) {
      const text = yield* response.text;
      return parseRobotsTxt(text);
    }
    return { disallowed: [], crawlDelay: null };
  }).pipe(
    Effect.catch(() => Effect.succeed({ disallowed: [], crawlDelay: null }))
  );

function getPriorityBucket(priority: number): "High" | "Medium" | "Low" {
  if (priority >= 10) return "High";
  if (priority >= 5) return "Medium";
  return "Low";
}

function addUrlsToState(state: DomainState, urls: readonly PrioritizedUrl[]): DomainState {
  const queues = {
    High: [...state.queues.High],
    Medium: [...state.queues.Medium],
    Low: [...state.queues.Low],
  };

  for (const prioritizedUrl of urls) {
    let existingBucket: "High" | "Medium" | "Low" | null = null;
    let existingIndex = -1;
    let existingPriority = -1;

    for (const bucket of ["High", "Medium", "Low"] as const) {
      const idx = queues[bucket].findIndex((u) => u.url === prioritizedUrl.url);
      if (idx !== -1) {
        const existingItem = queues[bucket][idx];
        if (existingItem) {
          existingBucket = bucket;
          existingIndex = idx;
          existingPriority = existingItem.priority;
        }
        break;
      }
    }

    const newBucket = getPriorityBucket(prioritizedUrl.priority);

    if (existingBucket !== null) {
      if (prioritizedUrl.priority > existingPriority) {
        queues[existingBucket].splice(existingIndex, 1);
        queues[newBucket].push(prioritizedUrl);
      }
    } else {
      queues[newBucket].push(prioritizedUrl);
    }
  }

  queues.High.sort((a, b) => a.priority - b.priority);
  queues.Medium.sort((a, b) => a.priority - b.priority);
  queues.Low.sort((a, b) => a.priority - b.priority);

  return {
    ...state,
    queues,
  };
}

function nextRandom(rngState: number): { nextRng: number; roll: number } {
  const nextRng = (Math.imul(rngState, 1103515245) + 12345) >>> 0;
  const roll = Math.floor(nextRng / 65536) % 100;
  return { nextRng, roll };
}

function getNextUrlFromState(state: DomainState): { nextState: DomainState; url: PrioritizedUrl | null } {
  const hasPending = state.queues.High.length > 0 || state.queues.Medium.length > 0 || state.queues.Low.length > 0;
  if (!hasPending) {
    return { nextState: state, url: null };
  }

  const { nextRng, roll } = nextRandom(rngStateVal(state));

  let queueOrder: ("High" | "Medium" | "Low")[];
  if (roll < 70) {
    queueOrder = ["High", "Medium", "Low"];
  } else if (roll < 90) {
    queueOrder = ["Medium", "High", "Low"];
  } else {
    queueOrder = ["Low", "High", "Medium"];
  }

  const queues = {
    High: [...state.queues.High],
    Medium: [...state.queues.Medium],
    Low: [...state.queues.Low],
  };

  let poppedUrl: PrioritizedUrl | null = null;
  for (const bucket of queueOrder) {
    if (queues[bucket].length > 0) {
      poppedUrl = queues[bucket].pop()!;
      break;
    }
  }

  return {
    nextState: {
      ...state,
      rngState: nextRng,
      queues,
    },
    url: poppedUrl,
  };
}

function rngStateVal(state: DomainState): number {
  return state.rngState ?? 12345;
}

// Check robots.txt rules
function isAllowedByRobots(state: DomainState, urlStr: string): boolean {
  if (state.robotsDisallowed === null) {
    return true;
  }
  try {
    const parsed = new URL(urlStr);
    const path = parsed.pathname;
    return !state.robotsDisallowed.some((prefix) => {
      if (prefix === "/") {
        return true;
      }
      return path.startsWith(prefix);
    });
  } catch {
    return false;
  }
}

// Calculate crawl priority
function calculatePriority(urlStr: string, boostWords: readonly string[]): number {
  let priority = 10;

  const schemeEnd = urlStr.indexOf("://");
  if (schemeEnd !== -1) {
    const pathPart = urlStr.slice(schemeEnd + 3);
    const firstSlash = pathPart.indexOf("/");
    if (firstSlash !== -1) {
      const segments = pathPart.slice(firstSlash)
        .split("/")
        .filter((s) => s.length > 0);
      priority -= segments.length;
    }
  }

  if (urlStr.includes("?")) {
    priority -= 2;
  }

  for (const word of boostWords) {
    if (urlStr.includes(word)) {
      priority += 2;
      break;
    }
  }

  return priority;
}

// Query uncrawled URLs using SqlClient
const filterUncrawledUrls = (sql: SqlClient.SqlClient, urls: readonly string[], cacheTtlSeconds: number | null) =>
  Effect.gen(function* () {
    if (urls.length === 0) return [];
    if (cacheTtlSeconds === 0) return urls;

    let crawledRows: readonly { url: string }[];
    if (cacheTtlSeconds !== null) {
      crawledRows = yield* sql<{ url: string }>`
        SELECT url FROM page_contents
        WHERE url = ANY(${urls})
          AND saved_at > CURRENT_TIMESTAMP - CAST(${cacheTtlSeconds} || ' second' AS INTERVAL)
      `;
    } else {
      crawledRows = yield* sql<{ url: string }>`
        SELECT url FROM page_contents
        WHERE url = ANY(${urls})
      `;
    }

    const crawledSet = new Set(crawledRows.map((r) => r.url));
    return urls.filter((u) => !crawledSet.has(u));
  });

export const DomainCrawlerAgent = defineAgent({
  name: "DomainCrawlerAgent",
  description: "Crawler handling worker queue per domain",
  mode: "durable",
  config: CrawlerConfig,
  constructorParams: { domainName: Schema.String },
  snapshot: Snapshot.define({
    schema: DomainState,
    policy: Snapshot.policy.everyN(10),
  }),
  methods: {
    enqueue: method({
      params: { urls: Schema.Array(PrioritizedUrl) },
      success: Schema.Void,
    }),
    getState: method({
      params: {},
      success: DomainState,
    }),
    setDelay: method({
      params: { delayMs: Schema.Number },
      success: Schema.Void,
    }),
    setCrossDomainPolicy: method({
      params: { policy: CrossDomainPolicy },
      success: Schema.Void,
    }),
    removeCrossDomainPolicy: method({
      params: {},
      success: Schema.Void,
    }),
    processNext: method({
      params: {},
      success: Schema.Void,
    }),
  },
}).implement(({ domainName }, snapshot) =>
  Effect.gen(function* () {
    const state = yield* snapshot.init({
      domain: domainName,
      politenessDelayMs: 1000,
      crossDomainPolicy: null,
      queues: {
        High: [],
        Medium: [],
        Low: [],
      },
      status: "Inactive",
      robotsDisallowed: null,
      rngState: 12345,
      processedCount: 0,
      errorCount: 0,
    });

    const sql = yield* getSql;
    const config = yield* CrawlerConfig;

    const scheduleNextStep = () =>
      Effect.gen(function* () {
        const stateVal = yield* Ref.get(state);
        const hasPending = stateVal.queues.High.length > 0 || stateVal.queues.Medium.length > 0 || stateVal.queues.Low.length > 0;
        if (hasPending) {
          const delayMs = stateVal.politenessDelayMs;
          const atMillis = Date.now() + delayMs;
          const scheduledAt = {
            seconds: BigInt(Math.floor(atMillis / 1000)),
            nanoseconds: (atMillis % 1000) * 1_000_000,
          };

          yield* Ref.update(state, (s) => ({ ...s, status: "Scheduled" as const }));
          const selfClient = yield* DomainCrawlerAgent.client.get({ domainName: stateVal.domain });
          yield* selfClient.processNext.schedule(scheduledAt, {});
        } else {
          yield* Ref.update(state, (s) => ({ ...s, status: "Inactive" as const }));
        }
      });

    return {
      enqueue: ({ urls }) =>
        Effect.gen(function* () {
          for (const u of urls) {
            try {
              const parsed = new URL(u.url);
              if (parsed.hostname !== domainName) {
                return yield* Effect.die(new Error(`URL does not belong to domain: ${u.url}`));
              }
            } catch {
              return yield* Effect.die(new Error(`Invalid URL format: ${u.url}`));
            }
          }

          const before = yield* Ref.get(state);
          yield* Ref.update(state, (s) => addUrlsToState(s, urls));
          const after = yield* Ref.get(state);

          if (before.status === "Inactive" && (after.queues.High.length > 0 || after.queues.Medium.length > 0 || after.queues.Low.length > 0)) {
            yield* scheduleNextStep();
          }
        }).pipe(Effect.orDie),

      getState: () => Ref.get(state).pipe(Effect.orDie),

      setDelay: ({ delayMs }) =>
        Ref.update(state, (s) => ({ ...s, politenessDelayMs: delayMs })).pipe(Effect.orDie),

      setCrossDomainPolicy: ({ policy }) =>
        Ref.update(state, (s) => ({ ...s, crossDomainPolicy: policy })).pipe(Effect.orDie),

      removeCrossDomainPolicy: () =>
        Ref.update(state, (s) => ({ ...s, crossDomainPolicy: null })).pipe(Effect.orDie),

      processNext: () =>
        Effect.gen(function* () {
          let stateVal = yield* Ref.get(state);
          const hasPending = stateVal.queues.High.length > 0 || stateVal.queues.Medium.length > 0 || stateVal.queues.Low.length > 0;
          if (!hasPending) {
            yield* Ref.update(state, (s) => ({ ...s, status: "Inactive" as const }));
            return;
          }

          if (stateVal.robotsDisallowed === null) {
            yield* Effect.logInfo(`Fetching robots.txt for domain: ${stateVal.domain}`);
            const { disallowed, crawlDelay } = yield* fetchRobotsTxt(stateVal.domain);
            yield* Ref.update(state, (s) => {
              const nextState = { ...s, robotsDisallowed: disallowed };
              if (crawlDelay !== null) {
                nextState.politenessDelayMs = crawlDelay;
              }
              return nextState;
            });
            stateVal = yield* Ref.get(state);
          }

          let poppedUrl: PrioritizedUrl | null = null;
          yield* Ref.modify(state, (s) => {
            const { nextState, url: item } = getNextUrlFromState(s);
            poppedUrl = item;
            return [null, nextState];
          });

          if (poppedUrl) {
            const target: PrioritizedUrl = poppedUrl;
            if (!isAllowedByRobots(stateVal, target.url)) {
              yield* Effect.logInfo(`URL disallowed by robots.txt, skipping: ${target.url}`);
              yield* scheduleNextStep();
              return;
            }

            yield* Ref.update(state, (s) => ({ ...s, status: "Processing" as const }));

            const fetcher = yield* FetcherAgent.client.newPhantom({});
            const fetchResultResult = yield* Effect.match(
              fetcher.fetchAndParse({ url: target.url }),
              {
                onFailure: (err) => ({ _tag: "Left" as const, error: err }),
                onSuccess: (val) => ({ _tag: "Right" as const, value: val }),
              }
            );

            if (fetchResultResult._tag === "Right") {
              const result = fetchResultResult.value;
              yield* Ref.update(state, (s) => ({
                ...s,
                processedCount: s.processedCount + 1,
              }));

              const maxUrlLen = yield* config.urlProcessing.maxUrlLength.get.pipe(Effect.map((v) => Redacted.value(v)));
              const boostWords = yield* config.urlProcessing.boostWords.get.pipe(Effect.map((v) => Redacted.value(v)));
              const normalizePrefixes = yield* config.urlProcessing.normalizePrefixes.get.pipe(Effect.map((v) => Redacted.value(v)));
              const cacheTtl = yield* config.urlProcessing.cacheTtlSeconds.get.pipe(Effect.map((v) => Redacted.value(v)));
              const configPolicyStr = yield* config.urlProcessing.crossDomainPolicy.get.pipe(Effect.map((v) => Redacted.value(v)));

              const currentPolicy = stateVal.crossDomainPolicy !== null
                ? stateVal.crossDomainPolicy
                : (configPolicyStr as CrossDomainPolicy);

              const candidateUrls: string[] = [];
              for (const linkStr of result.extractedLinks) {
                if (linkStr.length > maxUrlLen) continue;
                try {
                  const parsed = new URL(linkStr);
                  const domain = parsed.hostname;
                  let isAllowed = false;
                  if (currentPolicy === "None") {
                    const normalizedDomain = normalizeDomain(domain, normalizePrefixes);
                    isAllowed = normalizedDomain === stateVal.domain;
                  } else if (currentPolicy === "SubdomainsOnly") {
                    isAllowed = isSubdomain(domain, stateVal.domain);
                  } else if (currentPolicy === "Any") {
                    isAllowed = true;
                  }
                  if (isAllowed) {
                    candidateUrls.push(linkStr);
                  }
                } catch {
                  // ignore
                }
              }

              const uncrawledUrls = yield* filterUncrawledUrls(sql, candidateUrls, cacheTtl ?? null);

              const groupedByDomain = groupPrioritizedUrlsByNormalizedDomain(
                uncrawledUrls,
                normalizePrefixes,
                (u) => ({
                  url: u,
                  priority: calculatePriority(u, boostWords),
                })
              );

              for (const [domain, prioritizedUrls] of Object.entries(groupedByDomain)) {
                if (domain === stateVal.domain) {
                  yield* Ref.update(state, (s) => {
                    const allowed = prioritizedUrls.filter((u) => isAllowedByRobots(s, u.url));
                    return addUrlsToState(s, allowed);
                  });
                } else {
                  const client = yield* DomainCrawlerAgent.client.get({ domainName: domain });
                  yield* client.enqueue.trigger({ urls: prioritizedUrls });
                }
              }
            } else {
              yield* Effect.logError(`Failed to fetch URL ${target.url}: ${JSON.stringify(fetchResultResult.error)}`);
              yield* Ref.update(state, (s) => ({
                ...s,
                errorCount: s.errorCount + 1,
              }));
            }

            yield* scheduleNextStep();
          } else {
            yield* Ref.update(state, (s) => ({ ...s, status: "Inactive" as const }));
          }
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.orDie
        ),
    };
  })
);
import { HttpClientRequest } from "effect/unstable/http";
