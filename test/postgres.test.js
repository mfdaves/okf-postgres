"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { extractFromPostgres } = require("../src/postgres");
const { MockCatalogClient } = require("./support/mock-client");

const fixture = path.join(__dirname, "fixtures/query-results.json");

test("live extractor uses one read-only transaction and closes the client", async () => {
  let instance;
  class Client {
    constructor(config) {
      this.config = config;
      this.catalog = MockCatalogClient.fromFile(fixture);
      this.commands = [];
      this.connected = false;
      this.ended = false;
      instance = this;
    }

    async connect() { this.connected = true; }

    async query(config) {
      if (typeof config === "string") {
        this.commands.push(config);
        return { rows: [] };
      }
      return this.catalog.query(config);
    }

    async end() { this.ended = true; }
  }

  const catalog = await extractFromPostgres("postgresql://placeholder", { schemas: ["public"] }, { Client });
  assert.equal(catalog.relations.length, 3);
  assert.equal(instance.config.application_name, "okf-postgres");
  assert.equal(instance.connected, true);
  assert.deepEqual(instance.commands, [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "COMMIT",
  ]);
  assert.equal(instance.ended, true);
});

test("live extractor rolls back and closes the client when catalog extraction fails", async () => {
  let instance;
  class Client {
    constructor() {
      this.commands = [];
      this.ended = false;
      instance = this;
    }

    async connect() {}

    async query(config) {
      if (typeof config === "string") {
        this.commands.push(config);
        return { rows: [] };
      }
      throw new Error("catalog unavailable");
    }

    async end() { this.ended = true; }
  }

  await assert.rejects(
    extractFromPostgres("postgresql://placeholder", { schemas: ["public"] }, { Client }),
    /catalog unavailable/,
  );
  assert.deepEqual(instance.commands, [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "ROLLBACK",
  ]);
  assert.equal(instance.ended, true);
});
