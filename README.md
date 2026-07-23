# Golem Web Crawler (effect)

A distributed, agent-based web crawler built on the Golem Cloud platform using Effect and WebAssembly (WASM). It divides crawling tasks across isolated, domain-scoped agents that obey robots.txt compliance, schedule politeness-aware fetching loops, and persist content in a PostgreSQL database for full-text search querying.

---

## Architecture

The system uses Golem's actor-based architecture to divide and scale crawl jobs across domains. 

[The UML representation of the architecture is defined in](architecture.puml).

![Architecture Diagram](architecture.png)

```
[ Client / User ]
       │
       ▼ (HTTP Requests)
[ HTTP API Gateway ]
  ├── /crawler ──► [ OrchestratorAgent ]
  │                     │ (RPC - enqueue.trigger)
  │                     ▼
  ├── /domains ──► [ DomainCrawlerAgent (Per Domain) ]
  │                     │
  │                     ├── (Spawns & calls) ──► [ FetcherAgent ] ──► [ Target Websites ]
  │                     │                                                    │
  │                     └────────────────────── (Persists raw/text data) ────┼──┐
  │                                                                          │  │
  └── /search  ──► [ SearchAgent ] ──────────────────────────────────────────┼──┼──┐
                                                                             │  │  │
                                                                             ▼  ▼  ▼
                                                                     [ PostgreSQL DB ]
```

---

## Agents

The application implements four specialized Golem Agents:

### 1. OrchestratorAgent (Ephemeral)
* **Mount Path**: `/crawler`
* **Responsibilities**:
  * Acts as the main entry point to start crawl sessions.
  * Groups a list of seed URLs by their root domains.
  * Spawns or notifies the respective `DomainCrawlerAgent` for each unique domain.
  * Queries database for a list of crawled domains alongside their page counts.
  * Provides API endpoints to manage link filters (add, list, and delete filtering rules).

### 2. DomainCrawlerAgent (Durable, State-Managed)
* **Mount Path**: `/domains/{domain}`
* **Responsibilities**:
  * One instance is active per crawled domain.
  * Fetches and caches `robots.txt` rules for the domain and enforces politeness delays (obeying `Crawl-delay`).
  * Manages the priority queue of pending URLs for the domain.
  * Spawns and delegates page retrieval tasks to the ephemeral `FetcherAgent`.
  * Self-schedules its next processing loop step via Golem's future-scheduling capabilities.
  * Filters candidate URLs using a configurable Cache TTL (`cache_ttl_seconds`), allowing automatic re-crawling of stale pages (`Some(ttl)`), complete bypass for forced crawls (`Some(0)`), or permanent caching (`None`).
  * Normalizes domain names (stripping configurable prefixes like `www.`) and routes cross-domain URLs to other target domain agents according to the configured `crossDomainPolicy` (`None`, `SubdomainsOnly`, `Any`).

### 3. FetcherAgent (Ephemeral)
* **Responsibilities**:
  * Spanned on-demand per page request.
  * Fetches raw HTML content using async I/O.
  * Follows redirects and resolves relative links based on the final destination URL.
  * Extracts page title and links.
  * Loads and applies active link filters (such as domain blacklists, regex matches, keywords, and static file extensions) from the database during link extraction to ignore ads, spam, and social networks.
  * Saves page content, HTTP status, parsed text, and metadata to PostgreSQL under the final URL, and creates a redirect placeholder record under the original URL if a redirect occurred (preventing duplicate crawl loops).

### 4. SearchAgent (Ephemeral)
* **Mount Path**: `/search`
* **Responsibilities**:
  * Provides full-text query endpoints over all crawled page content.
  * Runs Postgres' `tsvector` and `tsquery` search indexes to rank relevance.

---

## Core Flows

### A. Initialization & Distribution Flow
1. Client calls `/crawler/start` with seed URLs.
2. `OrchestratorAgent` parses domain roots and distributes URLs.
3. If not already active, a new `DomainCrawlerAgent` is spawned per domain, and `enqueue.trigger` is invoked.

### B. Crawling & Processing Loop
1. `DomainCrawlerAgent` checks the cached `robots.txt` rules. If not loaded, it fetches them from the target website.
2. The agent pops the highest priority URL from its queue.
3. The agent verifies the target URL conforms to the disallowed prefixes.
4. If allowed, `DomainCrawlerAgent` calls `FetcherAgent` to fetch and parse the page.
5. `FetcherAgent` saves results into the database and returns discovered links.
6. `DomainCrawlerAgent` processes returned links:
   * Local URLs are filtered against robots.txt rules and re-queued.
   * Cross-domain URLs are routed to their respective `DomainCrawlerAgent`'s enqueue API.
7. The agent schedules its next step after the configured politeness delay.

---

## Infrastructure Dependencies

Infrastructure services are managed locally using Docker Compose:

* **PostgreSQL (with pgvector)**: Used for storing crawled web pages, metadata, and performing English full-text search indexing. It uses the `pgvector/pgvector:pg18-trixie` image.
* **Volume Mounts**: Local database state is persisted using the `postgres_data` volume.
* **Database Migrations**: Automatically initialized on startup using migrations mounted into `/docker-entrypoint-initdb.d`.

### Starting Infrastructure

To start the database dependency locally, execute:

```bash
docker compose up -d
```
