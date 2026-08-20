"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readCatalog } = require("../src/catalog");
const { generatePostgres, okfProducer, producePostgres } = require("../src/producer");
const { MockCatalogClient } = require("../test/support/mock-client");

async function validateThroughProducerHost(catalog, mcpRoot) {
  const { FileConceptStore, ProducerService, loadProjectConfig } = require(path.join(mcpRoot, "src"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-host-smoke-"));
  const bundleRoot = path.join(root, "okf", "database");
  fs.mkdirSync(bundleRoot, { recursive: true });
  const projectPath = path.join(root, "okf.project.yaml");
  fs.writeFileSync(projectPath, [
    "project: PostgreSQL host smoke",
    "bundles:",
    "  - id: database",
    "    root: okf/database",
    "producers:",
    "  - name: postgres",
    "    type: postgresql",
    "    package: '@mfdaves/okf-postgres'",
    "    bundle: database",
    "    config:",
    "      connectionEnv: DATABASE_URL",
    "      source: shop-db",
    "      schemas: [public]",
    "      includeIndexes: true",
    "",
  ].join("\n"), "utf8");
  try {
    const project = loadProjectConfig(projectPath);
    assert.deepEqual(project.errors, []);
    const descriptor = {
      ...okfProducer,
      generate: (context) => generatePostgres(context, { extract: async () => catalog }),
    };
    const service = new ProducerService({
      project,
      store: FileConceptStore.fromProject(projectPath),
      loader: async () => ({ okfProducer: descriptor }),
      env: { DATABASE_URL: "postgresql://mock.invalid/shop" },
      now: () => new Date("2026-08-20T10:00:00.000Z"),
    });
    const preview = await service.preview("postgres");
    assert.equal(preview.readyToApply, true, JSON.stringify(preview.diagnostics));
    assert.deepEqual(fs.readdirSync(bundleRoot), []);
    const applied = await service.run("postgres");
    assert.equal(applied.applied, true, JSON.stringify(applied.diagnostics));
    assert.equal(fs.existsSync(path.join(bundleRoot, ".okf-producer.json")), true);
    return applied.counts;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function smoke() {
  const fixture = path.join(__dirname, "../test/fixtures/query-results.json");
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "okf-postgres-smoke-"));
  const catalog = await readCatalog(MockCatalogClient.fromFile(fixture), { schemas: ["public"] });
  try {
    const result = await producePostgres({ catalog, output, source: "shop-db", bundle: "shop" });

    const mcpRoot = path.resolve(__dirname, "../../okf-mcp");
    const validator = path.join(mcpRoot, "bin/okf-mcp.js");
    if (!fs.existsSync(validator)) {
      throw new Error(`Sibling okf-mcp validator is required for smoke validation: ${validator}`);
    }
    const validation = spawnSync(process.execPath, [validator, "--root", output, "validate"], {
      encoding: "utf8",
    });
    if (validation.status !== 0) {
      if (validation.error) process.stderr.write(`${validation.error.stack || validation.error.message}\n`);
      process.stderr.write(validation.stdout || "");
      process.stderr.write(validation.stderr || "");
      throw new Error("Generated smoke bundle failed okf-mcp validation.");
    }
    const hostCounts = await validateThroughProducerHost(catalog, mcpRoot);
    process.stdout.write(`${JSON.stringify({ ...result, validated: true, producerHost: hostCounts }, null, 2)}\n`);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

smoke().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
