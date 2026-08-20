"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { readCatalog } = require("../src/catalog");
const {
  generatePostgres,
  okfProducer,
  postgresProducer,
  producePostgres,
  validateConfig,
} = require("../src/producer");
const { MockCatalogClient } = require("./support/mock-client");

const fixture = path.join(__dirname, "fixtures/query-results.json");

test("producer ABI generates sorted OKF files without publishing them", async () => {
  const catalog = await readCatalog(MockCatalogClient.fromFile(fixture), { schemas: ["public"] });
  let extraction;
  const result = await generatePostgres({
    bundleId: "shop",
    generatedAt: "2026-08-20T10:30:00Z",
    config: {
      connectionEnv: "SHOP_DATABASE_URL",
      source: "shop-db",
      schemas: ["public"],
      includeIndexes: true,
    },
    getSecret(name) {
      assert.equal(name, "SHOP_DATABASE_URL");
      return "postgresql://private-value";
    },
  }, {
    async extract(secret, options) {
      extraction = { secret, options };
      return catalog;
    },
  });

  assert.equal(okfProducer, postgresProducer);
  assert.equal(postgresProducer.apiVersion, "1");
  assert.equal(postgresProducer.okfVersion, "0.2");
  assert.equal(postgresProducer.id, "postgresql");
  assert.deepEqual(postgresProducer.relationTypes, ["contains", "contained_by", "foreign_key_to"]);
  assert.deepEqual(result.files.map((file) => file.path), [...result.files.map((file) => file.path)].sort());
  assert.equal(result.summary.files, 7);
  assert.equal(result.summary.databases, 1);
  assert.equal(result.summary.schemas, 1);
  assert.equal(result.summary.relations, 3);
  assert.equal(result.summary.enums, 1);
  assert.equal(extraction.secret, "postgresql://private-value");
  assert.deepEqual(extraction.options.schemas, ["public"]);
  assert.match(result.files.find((file) => file.path === "index.md").content, /okf_version: ['"]?0\.2/);
  assert.equal(JSON.stringify(result).includes("private-value"), false);
});

test("producer config accepts only safe metadata options", () => {
  const valid = validateConfig({ source: "shop-db", schemas: ["sales", "public", "sales"] });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.config.schemas, ["public", "sales"]);
  assert.equal(valid.config.connectionEnv, "DATABASE_URL");

  const invalid = validateConfig({
    connectionEnv: "postgresql://user:secret@example/db",
    output: "/tmp/catalog",
    sql: "SELECT * FROM customers",
  });
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.diagnostics.map((entry) => entry.field).sort(), ["connectionEnv", "output", "sql"]);
  assert.equal(JSON.stringify(invalid).includes("user:secret"), false);

  assert.equal(validateConfig({ allSchemas: true, schemas: ["public"] }).valid, false);
});

test("standalone producer keeps no-write preview behavior", async () => {
  const catalog = await readCatalog(MockCatalogClient.fromFile(fixture), { schemas: ["public"] });
  let published = false;
  const result = await producePostgres({
    catalog,
    source: "shop-db",
    bundle: "shop",
    output: "preview-only",
    dryRun: true,
  }, {
    now: () => new Date("2026-08-20T10:30:00Z"),
    writeBundle: () => { published = true; },
  });
  assert.equal(result.files, 7);
  assert.equal(result.generatedAt, "2026-08-20T10:30:00.000Z");
  assert.equal(published, false);
});
