"use strict";

const { readCatalog } = require("./catalog");

async function extractFromPostgres(connectionString, options = {}, dependencies = {}) {
  if (!connectionString || typeof connectionString !== "string") {
    throw new Error("The configured connection environment variable is empty.");
  }
  let Client = dependencies.Client;
  if (!Client) {
    try {
      ({ Client } = require("pg"));
    } catch (error) {
      throw new Error("The pg dependency is required for live PostgreSQL extraction.", { cause: error });
    }
  }

  const client = new Client({
    connectionString,
    application_name: "okf-postgres",
    connectionTimeoutMillis: options.connectionTimeoutMillis || 10000,
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const catalog = await readCatalog(client, options);
    await client.query("COMMIT");
    return catalog;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the extraction error.
    }
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = { extractFromPostgres };
