"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { readCatalog } = require("../src/catalog");
const { buildBundle, safeSegment } = require("../src/render");
const { MockCatalogClient } = require("./support/mock-client");

const fixture = path.join(__dirname, "fixtures/query-results.json");

test("renderer produces deterministic OKF concepts and relationship links", async () => {
  const catalog = await readCatalog(MockCatalogClient.fromFile(fixture), { schemas: ["public"] });
  const generatedAt = "2026-08-20T10:30:00Z";
  const first = buildBundle(catalog, { source: "shop-db", bundle: "shop", generatedAt });
  const second = buildBundle(catalog, { source: "shop-db", bundle: "shop", generatedAt });

  assert.deepEqual([...first], [...second]);
  assert.deepEqual([...first.keys()], [
    "index.md",
    "database.md",
    "schemas/public.md",
    "types/public/order_status.md",
    "tables/public/customers.md",
    "views/public/order_summary.md",
    "tables/public/orders.md",
  ]);
  const orders = first.get("tables/public/orders.md");
  assert.match(orders, /type: PostgreSQL Table/);
  assert.match(orders, /postgresql:\/\/shop-db\/public\/orders/);
  assert.match(orders, /foreign_key_to/);
  assert.match(orders, /\[public\.customers\]\(customers\.md\)/);
  assert.match(orders, /by: okf-postgres\/0\.1\.0/);
  assert.match(orders, /at: '2026-08-20T10:30:00\.000Z'/);
  assert.doesNotMatch(orders, /password/);
  assert.match(orders, /id column on public\.orders\./);
  assert.match(orders, /Owning customer/);
  assert.match(orders, /ON DELETE CASCADE DEFERRABLE/);

  const rootIndex = first.get("index.md");
  assert.match(rootIndex, /- \[shop\]\(database\.md\)/);
  const database = first.get("database.md");
  assert.match(database, /type: PostgreSQL Database/);
  assert.match(database, /description: Shop application database/);
  assert.match(database, /\[public\]\(schemas\/public\.md\)/);

  const schema = first.get("schemas/public.md");
  assert.match(schema, /description: Application data/);

  const customers = first.get("tables/public/customers.md");
  assert.match(customers, /description: Registered customers/);
  assert.match(customers, /Customer identifier/);
  assert.match(customers, /identity by default/);
  assert.match(customers, /generated stored/);

  const enumType = first.get("types/public/order_status.md");
  assert.match(enumType, /type: PostgreSQL Enum/);
  assert.match(enumType, /<code>paid<\/code>/);

  const view = first.get("views/public/order_summary.md");
  assert.match(view, /# Definition/);
  assert.match(view, /GROUP BY customer_id/);
});

test("unsafe or colliding PostgreSQL identifiers receive stable disambiguated paths", () => {
  assert.equal(safeSegment("orders"), "orders");
  assert.match(safeSegment("Sales / EMEA"), /^Sales-EMEA--[a-f0-9]{8}$/);
  assert.notEqual(safeSegment("Sales / EMEA"), safeSegment("Sales - EMEA"));
});

test("renderer supports every relation kind extracted by the catalog query", () => {
  const kinds = ["table", "partitioned_table", "foreign_table", "view", "materialized_view"];
  const catalog = {
    database: "shop",
    serverVersion: "16",
    schemas: [{ name: "public", comment: null }],
    relations: kinds.map((kind, index) => ({
      oid: String(index + 1),
      schema: "public",
      name: `object_${index}`,
      kind,
      comment: null,
      definition: kind.includes("view") ? "SELECT 1" : null,
      columns: [],
      constraints: [],
      indexes: [],
    })),
  };
  const files = buildBundle(catalog, { source: "shop" });
  assert.equal(files.size, 8);
  assert.equal([...files.values()].some((content) => content.includes("PostgreSQL Materialized View")), true);
  assert.equal([...files.values()].some((content) => content.includes("PostgreSQL Foreign Table")), true);
});

test("renderer links a cross-schema foreign key and retains its full definition", () => {
  const account = {
    oid: "1",
    schema: "sales",
    name: "accounts",
    kind: "table",
    comment: "Billing accounts",
    definition: null,
    columns: [],
    constraints: [],
    indexes: [],
  };
  const order = {
    oid: "2",
    schema: "public",
    name: "orders",
    kind: "table",
    comment: "Orders",
    definition: null,
    columns: [],
    indexes: [],
    constraints: [{
      name: "orders_account_fkey",
      type: "foreign_key",
      columns: ["account_id"],
      referencedSchema: "sales",
      referencedRelation: "accounts",
      referencedColumns: ["id"],
      definition: "FOREIGN KEY (account_id) REFERENCES sales.accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE",
    }],
  };
  const files = buildBundle({
    database: "shop",
    databaseComment: "Shop database",
    serverVersion: "16",
    schemas: [
      { name: "public", comment: "Application data" },
      { name: "sales", comment: "Sales data" },
    ],
    relations: [order, account],
    enums: [],
  }, { source: "shop-db", bundle: "shop", generatedAt: "2026-08-20T10:30:00Z" });

  const rendered = files.get("tables/public/orders.md");
  assert.match(rendered, /target: okf:\/\/shop\/tables\/sales\/accounts/);
  assert.match(rendered, /\[sales\.accounts\]\(\.\.\/sales\/accounts\.md\)/);
  assert.match(rendered, /ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE/);
});

test("root index always list-links database.md for an empty-schema catalog", () => {
  const files = buildBundle({
    database: null,
    databaseComment: null,
    serverVersion: null,
    schemas: [],
    relations: [],
    enums: [],
  }, { source: "empty-db", bundle: "empty" });

  assert.match(files.get("index.md"), /- \[empty-db\]\(database\.md\)/);
  assert.equal(files.has("database.md"), true);
});
