"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { readCatalog } = require("../src/catalog");
const { MockCatalogClient } = require("./support/mock-client");

const fixture = path.join(__dirname, "fixtures/query-results.json");

test("catalog reader assembles the PostgreSQL metadata average users need", async () => {
  const client = MockCatalogClient.fromFile(fixture);
  const catalog = await readCatalog(client, { schemas: ["public"] });

  assert.equal(catalog.database, "shop");
  assert.equal(catalog.databaseComment, "Shop application database");
  assert.equal(catalog.serverVersion, "16.4");
  assert.deepEqual(catalog.schemas, [{ name: "public", comment: "Application data" }]);
  assert.equal(catalog.relations.length, 3);

  const orders = catalog.relations.find((relation) => relation.name === "orders");
  assert.deepEqual(orders.columns.map((column) => column.name), ["id", "customer_id", "status"]);
  assert.equal(orders.columns[0].identity, "by default");
  const customers = catalog.relations.find((relation) => relation.name === "customers");
  assert.equal(customers.columns.find((column) => column.name === "email_normalized").generated, "stored");
  assert.equal(orders.constraints[0].type, "foreign_key");
  assert.equal(orders.constraints[0].referencedRelation, "customers");
  assert.equal(orders.constraints.some((constraint) => constraint.type === "check"), true);
  assert.equal(orders.indexes[0].name, "orders_customer_id_idx");
  assert.deepEqual(catalog.enums, [{
    schema: "public",
    name: "order_status",
    comment: "Lifecycle states for an order",
    values: ["pending", "paid", "cancelled"],
  }]);
  assert.deepEqual(client.calls.map((call) => call.key), [
    "database", "schemas", "relations", "columns", "constraints", "indexes", "enums",
  ]);
  assert.deepEqual(client.calls[1].values, [["public"]]);
});

test("catalog reader can discover accessible user schemas", async () => {
  const client = MockCatalogClient.fromFile(fixture);
  const catalog = await readCatalog(client, { allSchemas: true, includeIndexes: false });
  assert.deepEqual(catalog.schemas.map((schema) => schema.name), ["public"]);
  assert.equal(client.calls[1].key, "allschemas");
  assert.deepEqual(client.calls[2].values, [["public"]]);
});

test("catalog reader reports requested schemas that are unavailable", async () => {
  const client = MockCatalogClient.fromFile(fixture);
  await assert.rejects(
    readCatalog(client, { schemas: ["public", "missing"] }),
    /not found or accessible: missing/,
  );
});

test("catalog reader can omit index metadata", async () => {
  const client = MockCatalogClient.fromFile(fixture);
  const catalog = await readCatalog(client, { schemas: ["public"], includeIndexes: false });
  assert.equal(catalog.relations.every((relation) => relation.indexes.length === 0), true);
  assert.equal(client.calls.some((call) => call.key === "indexes"), false);
});

test("catalog reader preserves multi-schema and cross-schema foreign-key metadata", async () => {
  const responses = JSON.parse(fs.readFileSync(fixture, "utf8"));
  responses.schemas.push({ schema_name: "sales", comment: "Sales-owned reference data" });
  responses.relations.push({
    relation_oid: "200",
    schema_name: "sales",
    relation_name: "accounts",
    relation_kind: "table",
    comment: "Customer billing accounts",
    view_definition: null,
  });
  responses.columns.push({
    relation_oid: "200",
    schema_name: "sales",
    relation_name: "accounts",
    ordinal_position: 1,
    column_name: "id",
    data_type: "bigint",
    is_nullable: false,
    column_default: null,
    identity_kind: "",
    generated_kind: "",
    comment: "Billing account identifier",
  });
  responses.constraints.push({
    relation_oid: "101",
    schema_name: "public",
    relation_name: "orders",
    constraint_name: "orders_account_id_fkey",
    constraint_type: "foreign_key",
    columns: ["customer_id"],
    referenced_schema: "sales",
    referenced_relation: "accounts",
    referenced_columns: ["id"],
    definition: "FOREIGN KEY (customer_id) REFERENCES sales.accounts(id) ON DELETE RESTRICT DEFERRABLE",
  });

  const catalog = await readCatalog(new MockCatalogClient(responses), { schemas: ["public", "sales"] });
  assert.deepEqual(catalog.schemas.map((schema) => schema.name), ["public", "sales"]);
  const foreignKey = catalog.relations
    .find((relation) => relation.name === "orders")
    .constraints.find((constraint) => constraint.name === "orders_account_id_fkey");
  assert.equal(foreignKey.referencedSchema, "sales");
  assert.equal(foreignKey.referencedRelation, "accounts");
  assert.match(foreignKey.definition, /ON DELETE RESTRICT DEFERRABLE/);
});
