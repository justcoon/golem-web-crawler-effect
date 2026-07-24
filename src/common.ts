import { Schema } from "effect";

export const FilterType = Schema.Union([
  Schema.Literal("domain_blacklist"),
  Schema.Literal("url_regex"),
  Schema.Literal("keyword"),
  Schema.Literal("extension")
]);
export type FilterType = Schema.Schema.Type<typeof FilterType>;

export const LinkFilter = Schema.Struct({
  id: Schema.Number,
  pattern: Schema.String,
  filterType: FilterType,
  isActive: Schema.Boolean,
  createdAt: Schema.String,
});
export type LinkFilter = Schema.Schema.Type<typeof LinkFilter>;

export const PrioritizedUrl = Schema.Struct({
  url: Schema.String,
  priority: Schema.Number,
});
export type PrioritizedUrl = Schema.Schema.Type<typeof PrioritizedUrl>;

export const CrossDomainPolicy = Schema.Union([
  Schema.Literal("None"),
  Schema.Literal("SubdomainsOnly"),
  Schema.Literal("Any")
]);
export type CrossDomainPolicy = Schema.Schema.Type<typeof CrossDomainPolicy>;

export const ProcessingStatus = Schema.Union([
  Schema.Literal("Inactive"),
  Schema.Literal("Scheduled"),
  Schema.Literal("Processing")
]);
export type ProcessingStatus = Schema.Schema.Type<typeof ProcessingStatus>;

export const PriorityBucket = Schema.Union([
  Schema.Literal("High"),
  Schema.Literal("Medium"),
  Schema.Literal("Low")
]);
export type PriorityBucket = Schema.Schema.Type<typeof PriorityBucket>;

export const DomainState = Schema.Struct({
  domain: Schema.String,
  politenessDelayMs: Schema.Number,
  crossDomainPolicy: Schema.Union([Schema.Null, CrossDomainPolicy]),
  queues: Schema.Struct({
    High: Schema.Array(PrioritizedUrl),
    Medium: Schema.Array(PrioritizedUrl),
    Low: Schema.Array(PrioritizedUrl),
  }),
  status: ProcessingStatus,
  robotsDisallowed: Schema.Union([Schema.Null, Schema.Array(Schema.String)]),
  rngState: Schema.Number,
  processedCount: Schema.Number,
  errorCount: Schema.Number,
});
export type DomainState = Schema.Schema.Type<typeof DomainState>;

export function normalizeDomain(domain: string, normalizePrefixes: readonly string[]): string {
  const domainLower = domain.toLowerCase();
  for (const prefix of normalizePrefixes) {
    const prefixDot = `${prefix.toLowerCase()}.`;
    if (domainLower.startsWith(prefixDot)) {
      return domainLower.slice(prefixDot.length);
    }
  }
  return domainLower;
}

export function normalizeUrlDomain(urlStr: string, normalizePrefixes: readonly string[]): URL {
  const parsed = new URL(urlStr);
  parsed.hostname = normalizeDomain(parsed.hostname, normalizePrefixes);
  return parsed;
}

export function isSubdomain(sub: string, parent: string): boolean {
  return sub === parent || sub.endsWith(`.${parent}`);
}

export function groupUrlsByDomain(urls: readonly string[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const urlStr of urls) {
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname;
      if (host) {
        if (!grouped[host]) {
          grouped[host] = [];
        }
        grouped[host].push(urlStr);
      }
    } catch {
      // ignore invalid URLs
    }
  }
  return grouped;
}

export function groupPrioritizedUrlsByDomain(
  urls: readonly string[],
  prioritize: (url: string) => PrioritizedUrl
): Record<string, PrioritizedUrl[]> {
  const groupedUrls = groupUrlsByDomain(urls);
  const grouped: Record<string, PrioritizedUrl[]> = {};
  for (const [domain, urlsList] of Object.entries(groupedUrls)) {
    grouped[domain] = urlsList.map(prioritize);
  }
  return grouped;
}
