import { Schema, Redacted, Effect } from "effect";
import { defineConfig } from "@golemcloud/effect-golem";
import { PgClient } from "@golemcloud/effect-golem/postgres";

export class CrawlerConfig extends defineConfig("Crawler.Config", {
  db: Schema.Struct({
    host: Schema.String,
    db: Schema.String,
    port: Schema.String,
    user: Schema.Redacted(Schema.String),
    password: Schema.Redacted(Schema.String),
  }),
  urlProcessing: Schema.Struct({
    boostWords: Schema.Array(Schema.String),
    maxUrlLength: Schema.Number,
    crossDomainPolicy: Schema.String,
    normalizePrefixes: Schema.Array(Schema.String),
    cacheTtlSeconds: Schema.Option(Schema.Number),
  }),
}) {}

export const getSql = Effect.gen(function* () {
  const config = yield* CrawlerConfig;
  const host = yield* config.db.host;
  const dbName = yield* config.db.db;
  const port = yield* config.db.port;
  const user = Redacted.value(yield* config.db.user.get);
  const password = Redacted.value(yield* config.db.password.get);
  const connectionAddress = `postgres://${user}:${password}@${host}:${port}/${dbName}`;
  return yield* PgClient.make({ connectionAddress });
});
