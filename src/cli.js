"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { producePostgres } = require("./producer");
const packageJson = require("../package.json");

function usage() {
  return [
    "Usage:",
    "  okf-postgres generate --out <directory> [options]",
    "",
    "Options:",
    "  --connection-env <name>  Environment variable holding the PostgreSQL URL (default: DATABASE_URL)",
    "  --source <alias>         Stable source alias used in generated identifiers (default: postgres)",
    "  --bundle <id>            OKF bundle id (default: source alias)",
    "  --schema <name>          PostgreSQL schema to include; repeatable (default: public)",
    "  --all-schemas            Include every accessible non-system schema",
    "  --no-indexes             Do not include index definitions",
    "  --catalog-file <path>    Use a normalized catalog JSON file instead of a live database",
    "  --dry-run                Extract and render without writing files",
    "  --json                   Print a machine-readable result",
    "  -h, --help               Show help",
    "  -v, --version            Show version",
  ].join("\n");
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseArgs(argv) {
  const config = {
    command: null,
    connectionEnv: "DATABASE_URL",
    source: "postgres",
    bundle: null,
    schemas: [],
    allSchemas: false,
    includeIndexes: true,
    output: null,
    catalogFile: null,
    json: false,
    dryRun: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "generate" && !config.command) config.command = arg;
    else if (arg === "-h" || arg === "--help") config.help = true;
    else if (arg === "-v" || arg === "--version") config.version = true;
    else if (arg === "--json") config.json = true;
    else if (arg === "--dry-run") config.dryRun = true;
    else if (arg === "--all-schemas") config.allSchemas = true;
    else if (arg === "--no-indexes") config.includeIndexes = false;
    else if (["--connection-env", "--source", "--bundle", "--schema", "--out", "--catalog-file"].includes(arg)) {
      const value = requireValue(argv, index, arg);
      index += 1;
      if (arg === "--connection-env") config.connectionEnv = value;
      if (arg === "--source") config.source = value;
      if (arg === "--bundle") config.bundle = value;
      if (arg === "--schema") config.schemas.push(value);
      if (arg === "--out") config.output = value;
      if (arg === "--catalog-file") config.catalogFile = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  config.bundle = config.bundle || config.source;
  if (config.allSchemas && config.schemas.length) throw new Error("--all-schemas cannot be combined with --schema.");
  if (!config.allSchemas && !config.schemas.length) config.schemas = ["public"];
  return config;
}

function loadCatalogFile(filePath) {
  const absolute = path.resolve(filePath);
  const catalog = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const validSchemas = catalog && Array.isArray(catalog.schemas)
    && catalog.schemas.every((schema) => schema && typeof schema.name === "string");
  const validRelations = catalog && Array.isArray(catalog.relations)
    && catalog.relations.every((relation) => relation
      && typeof relation.schema === "string"
      && typeof relation.name === "string"
      && typeof relation.kind === "string"
      && Array.isArray(relation.columns)
      && Array.isArray(relation.constraints)
      && Array.isArray(relation.indexes));
  const validEnums = catalog && (catalog.enums === undefined || (Array.isArray(catalog.enums)
    && catalog.enums.every((value) => value
      && typeof value.schema === "string"
      && typeof value.name === "string"
      && Array.isArray(value.values))));
  if (!validSchemas || !validRelations || !validEnums) {
    throw new Error("Catalog file must contain normalized schemas and relations arrays.");
  }
  return catalog;
}

async function run(argv, environment = process.env, dependencies = {}) {
  const config = parseArgs(argv);
  if (config.version) return { mode: "version", text: packageJson.version };
  if (config.help || !config.command) return { mode: "help", text: usage() };
  if (config.command !== "generate") throw new Error(`Unknown command: ${config.command}`);
  if (!config.output) throw new Error("generate requires --out <directory>.");

  const catalog = config.catalogFile ? loadCatalogFile(config.catalogFile) : null;
  const result = await producePostgres({
    catalog,
    connectionEnv: config.connectionEnv,
    source: config.source,
    bundle: config.bundle,
    schemas: config.schemas,
    allSchemas: config.allSchemas,
    includeIndexes: config.includeIndexes,
    output: config.output,
    dryRun: config.dryRun,
  }, { ...dependencies, environment });
  return {
    mode: "generate",
    json: config.json,
    result,
  };
}

async function main(argv = process.argv.slice(2), io = console, environment = process.env) {
  try {
    const outcome = await run(argv, environment);
    if (outcome.mode === "help" || outcome.mode === "version") io.log(outcome.text);
    else if (outcome.json) io.log(JSON.stringify(outcome.result));
    else {
      const action = outcome.result.dryRun ? "Previewed" : "Generated";
      io.log(`${action} ${outcome.result.files} files for ${outcome.result.relations} PostgreSQL relations in ${outcome.result.output}.`);
    }
    return 0;
  } catch (error) {
    io.error(`okf-postgres: ${error.message}`);
    return 1;
  }
}

module.exports = { loadCatalogFile, main, parseArgs, run, usage };
