"use strict";

const path = require("node:path");
const packageJson = require("../package.json");
const { extractFromPostgres } = require("./postgres");
const { buildBundle } = require("./render");
const { writeBundle } = require("./write");

const CONFIG_KEYS = new Set([
  "connectionEnv",
  "source",
  "schemas",
  "allSchemas",
  "includeIndexes",
]);
const RELATION_TYPES = Object.freeze(["contains", "contained_by", "foreign_key_to"]);

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("generatedAt must be a valid ISO datetime or Date.");
  return date.toISOString();
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateConfig(value = {}) {
  const diagnostics = [];
  const input = isPlainObject(value) ? value : {};
  if (!isPlainObject(value)) {
    diagnostics.push({
      code: "invalid_config",
      field: "config",
      message: "Producer config must be an object.",
    });
  }
  Object.keys(input).filter((key) => !CONFIG_KEYS.has(key)).sort().forEach((key) => {
    diagnostics.push({
      code: "unknown_config_key",
      field: key,
      message: `Unsupported PostgreSQL producer config key: ${key}.`,
    });
  });

  const requestedConnectionEnv = typeof input.connectionEnv === "string" && input.connectionEnv.trim()
    ? input.connectionEnv.trim()
    : "DATABASE_URL";
  const connectionEnvValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(requestedConnectionEnv);
  if (!connectionEnvValid) {
    diagnostics.push({
      code: "invalid_connection_env",
      field: "connectionEnv",
      message: "connectionEnv must be an environment-variable name.",
    });
  }
  const connectionEnv = connectionEnvValid ? requestedConnectionEnv : "DATABASE_URL";

  const requestedSource = typeof input.source === "string" && input.source.trim()
    ? input.source.trim()
    : "postgres";
  const sourceValid = /^[A-Za-z0-9_.-]+$/.test(requestedSource);
  if (!sourceValid) {
    diagnostics.push({
      code: "invalid_source",
      field: "source",
      message: "source may contain only letters, numbers, dots, underscores, and hyphens.",
    });
  }
  const source = sourceValid ? requestedSource : "postgres";

  const allSchemas = input.allSchemas === true;
  if (input.allSchemas !== undefined && typeof input.allSchemas !== "boolean") {
    diagnostics.push({
      code: "invalid_all_schemas",
      field: "allSchemas",
      message: "allSchemas must be a boolean.",
    });
  }
  if (input.includeIndexes !== undefined && typeof input.includeIndexes !== "boolean") {
    diagnostics.push({
      code: "invalid_include_indexes",
      field: "includeIndexes",
      message: "includeIndexes must be a boolean.",
    });
  }

  let schemas = ["public"];
  if (input.schemas !== undefined) {
    if (!Array.isArray(input.schemas) || input.schemas.some((schema) => typeof schema !== "string" || !schema.trim())) {
      diagnostics.push({
        code: "invalid_schemas",
        field: "schemas",
        message: "schemas must be an array of non-empty schema names.",
      });
      schemas = [];
    } else {
      schemas = [...new Set(input.schemas.map((schema) => schema.trim()))].sort();
    }
  }
  if (allSchemas && input.schemas !== undefined && schemas.length) {
    diagnostics.push({
      code: "conflicting_schema_selection",
      field: "schemas",
      message: "schemas cannot be combined with allSchemas.",
    });
  }
  if (!allSchemas && schemas.length === 0) {
    diagnostics.push({
      code: "empty_schema_selection",
      field: "schemas",
      message: "At least one schema is required unless allSchemas is true.",
    });
  }

  return {
    valid: diagnostics.length === 0,
    config: {
      connectionEnv,
      source,
      schemas: allSchemas ? [] : schemas,
      allSchemas,
      includeIndexes: input.includeIndexes !== false,
    },
    diagnostics,
  };
}

function requireValidConfig(value) {
  const validation = validateConfig(value);
  if (!validation.valid) {
    const error = new Error(validation.diagnostics.map((entry) => entry.message).join(" "));
    error.diagnostics = validation.diagnostics;
    throw error;
  }
  return validation.config;
}

function sortedFiles(files) {
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, content]) => ({ path: filePath, content }));
}

async function generatePostgres(context = {}, dependencies = {}) {
  const config = requireValidConfig(context.config || {});
  const bundle = String(context.bundleId || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(bundle)) {
    throw new Error("bundleId may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  if (context.signal && context.signal.aborted) {
    throw context.signal.reason || new Error("PostgreSQL production was aborted.");
  }
  if (typeof context.getSecret !== "function") {
    throw new Error("PostgreSQL production requires getSecret(name).");
  }

  const secret = await context.getSecret(config.connectionEnv);
  if (typeof secret !== "string" || !secret) {
    throw new Error(`Connection environment variable ${config.connectionEnv} is empty.`);
  }
  const extract = dependencies.extract || extractFromPostgres;
  const now = dependencies.now || (() => new Date());
  const generatedAt = normalizeTimestamp(context.generatedAt === undefined ? now() : context.generatedAt);
  const catalog = await extract(secret, {
    schemas: config.schemas,
    allSchemas: config.allSchemas,
    includeIndexes: config.includeIndexes,
    signal: context.signal,
  }, dependencies);
  if (context.signal && context.signal.aborted) {
    throw context.signal.reason || new Error("PostgreSQL production was aborted.");
  }
  const files = buildBundle(catalog, {
    source: config.source,
    bundle,
    includeIndexes: config.includeIndexes,
    generatedAt,
    producerVersion: packageJson.version,
  });
  return {
    files: sortedFiles(files),
    summary: {
      databases: 1,
      schemas: catalog.schemas.length,
      relations: catalog.relations.length,
      enums: Array.isArray(catalog.enums) ? catalog.enums.length : 0,
      files: files.size,
    },
  };
}

async function producePostgres(options = {}, dependencies = {}) {
  const producerConfig = requireValidConfig({
    connectionEnv: options.connectionEnv,
    source: options.source,
    schemas: options.schemas,
    allSchemas: options.allSchemas,
    includeIndexes: options.includeIndexes,
  });
  const source = producerConfig.source;
  const bundle = String(options.bundle || source).trim();
  const output = options.output ? path.resolve(options.output) : null;
  if (!output) throw new Error("PostgreSQL production requires an output directory.");

  const schemas = producerConfig.schemas;
  const includeIndexes = producerConfig.includeIndexes;
  const environment = dependencies.environment || process.env;
  const extract = dependencies.extract || extractFromPostgres;
  const publish = dependencies.writeBundle || writeBundle;
  const now = dependencies.now || (() => new Date());
  const generatedAt = normalizeTimestamp(options.generatedAt === undefined ? now() : options.generatedAt);
  const connectionEnv = producerConfig.connectionEnv;
  if (!options.catalog && (!environment[connectionEnv] || typeof environment[connectionEnv] !== "string")) {
    throw new Error(`Connection environment variable ${connectionEnv} is empty.`);
  }
  const catalog = options.catalog || await extract(environment[connectionEnv], {
    schemas,
    allSchemas: producerConfig.allSchemas,
    includeIndexes,
  }, dependencies);
  const files = buildBundle(catalog, {
    source,
    bundle,
    includeIndexes,
    generatedAt,
    producerVersion: packageJson.version,
  });
  const publication = options.dryRun
    ? { output, files: files.size, removed: 0 }
    : publish(output, files, {
      producer: "postgresql",
      producerVersion: packageJson.version,
      bundle,
    });

  return {
    producer: "okf-postgres",
    version: packageJson.version,
    source,
    bundle,
    database: catalog.database || null,
    schemas: catalog.schemas.length,
    relations: catalog.relations.length,
    enums: Array.isArray(catalog.enums) ? catalog.enums.length : 0,
    generatedAt,
    dryRun: options.dryRun === true,
    ...publication,
  };
}

const postgresProducer = Object.freeze({
  apiVersion: "1",
  okfVersion: "0.2",
  id: "postgresql",
  name: "okf-postgres",
  version: packageJson.version,
  relationTypes: RELATION_TYPES,
  validateConfig,
  generate: generatePostgres,
});

const okfProducer = postgresProducer;

module.exports = {
  generatePostgres,
  normalizeTimestamp,
  okfProducer,
  postgresProducer,
  producePostgres,
  validateConfig,
};
