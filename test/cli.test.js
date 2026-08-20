"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadCatalogFile, parseArgs, run } = require("../src/cli");
const { readCatalog } = require("../src/catalog");
const { MockCatalogClient } = require("./support/mock-client");

const fixture = path.join(__dirname, "fixtures/query-results.json");

test("CLI generates a complete bundle from a normalized catalog file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = await readCatalog(MockCatalogClient.fromFile(fixture), { schemas: ["public"] });
  const catalogFile = path.join(root, "catalog.json");
  const output = path.join(root, "bundle");
  fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  const outcome = await run([
    "generate",
    "--catalog-file", catalogFile,
    "--source", "shop-db",
    "--bundle", "shop",
    "--out", output,
  ], {});

  assert.equal(outcome.result.relations, 3);
  assert.equal(outcome.result.files, 7);
  assert.equal(outcome.result.enums, 1);
  assert.equal(fs.existsSync(path.join(output, "tables/public/orders.md")), true);
  assert.equal(fs.existsSync(path.join(output, ".okf-producer.json")), true);

  const previewOutput = path.join(root, "preview");
  const preview = await run([
    "generate", "--catalog-file", catalogFile, "--out", previewOutput, "--dry-run",
  ], {}, { now: () => new Date("2026-08-20T10:30:00Z") });
  assert.equal(preview.result.dryRun, true);
  assert.equal(fs.existsSync(previewOutput), false);
});

test("CLI names a missing connection variable without exposing another value", async () => {
  await assert.rejects(
    run(["generate", "--connection-env", "MY_DATABASE", "--out", "unused"], {}),
    /Connection environment variable MY_DATABASE is empty/,
  );
});

test("CLI accepts multiple schemas and the index opt-out", () => {
  const config = parseArgs([
    "generate", "--out", "bundle", "--schema", "public", "--schema", "sales", "--no-indexes",
  ]);
  assert.deepEqual(config.schemas, ["public", "sales"]);
  assert.equal(config.includeIndexes, false);

  const all = parseArgs(["generate", "--out", "bundle", "--all-schemas", "--dry-run"]);
  assert.equal(all.allSchemas, true);
  assert.equal(all.dryRun, true);
  assert.deepEqual(all.schemas, []);
  assert.throws(
    () => parseArgs(["generate", "--out", "bundle", "--all-schemas", "--schema", "public"]),
    /cannot be combined/,
  );
  assert.throws(() => loadCatalogFile(fixture), /normalized schemas and relations/);
});
