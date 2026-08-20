"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const yaml = require("js-yaml");
const packageJson = require("../package.json");

const KIND = {
  table: { directory: "tables", type: "PostgreSQL Table", label: "table" },
  partitioned_table: { directory: "tables", type: "PostgreSQL Partitioned Table", label: "partitioned table" },
  foreign_table: { directory: "tables", type: "PostgreSQL Foreign Table", label: "foreign table" },
  view: { directory: "views", type: "PostgreSQL View", label: "view" },
  materialized_view: { directory: "views", type: "PostgreSQL Materialized View", label: "materialized view" },
};

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeSegment(value) {
  const original = String(value).normalize("NFC");
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(original) && original !== "." && original !== "..") {
    return original;
  }
  const base = original.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "object";
  const digest = crypto.createHash("sha256").update(original).digest("hex").slice(0, 8);
  return `${base}--${digest}`;
}

function markdownLinkText(value) {
  return oneLine(value).replace(/([\\\[\]])/g, "\\$1");
}

function tableCell(value) {
  return oneLine(value).replace(/\|/g, "\\|");
}

function htmlCode(value) {
  if (value === null || value === undefined || value === "") return "—";
  const escaped = String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;")
    .replace(/\r?\n/g, " ");
  return `<code>${escaped}</code>`;
}

function fenced(language, content) {
  const matches = String(content).match(/`+/g) || [];
  const width = Math.max(3, ...matches.map((value) => value.length + 1));
  const fence = "`".repeat(width);
  return `${fence}${language}\n${String(content).trim()}\n${fence}`;
}

function dumpFrontmatter(frontmatter) {
  return yaml.dump(frontmatter, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  }).trimEnd();
}

function conceptMarkdown(frontmatter, body) {
  return `---\n${dumpFrontmatter(frontmatter)}\n---\n\n${String(body).trim()}\n`;
}

function relationShape(relation) {
  const shape = KIND[relation.kind];
  if (!shape) throw new Error(`Unsupported PostgreSQL relation kind: ${relation.kind}`);
  return shape;
}

function relationFile(relation) {
  const shape = relationShape(relation);
  return `${shape.directory}/${safeSegment(relation.schema)}/${safeSegment(relation.name)}.md`;
}

function relationUri(bundle, relation) {
  return `okf://${bundle}/${relationFile(relation).slice(0, -3)}`;
}

function schemaFile(schema) {
  return `schemas/${safeSegment(schema)}.md`;
}

function schemaUri(bundle, schema) {
  return `okf://${bundle}/${schemaFile(schema).slice(0, -3)}`;
}

function resourceUri(source, ...parts) {
  const base = `postgresql://${encodeURIComponent(source)}`;
  return parts.length ? `${base}/${parts.map((part) => encodeURIComponent(part)).join("/")}` : base;
}

function generatedMetadata(options) {
  const generated = { by: `okf-postgres/${options.producerVersion}` };
  if (options.generatedAt) generated.at = options.generatedAt;
  return generated;
}

function enumFile(value) {
  return `types/${safeSegment(value.schema)}/${safeSegment(value.name)}.md`;
}

function enumUri(bundle, value) {
  return `okf://${bundle}/${enumFile(value).slice(0, -3)}`;
}

function relationDescription(source, relation) {
  return oneLine(relation.comment)
    || `PostgreSQL ${relationShape(relation).label} ${relation.schema}.${relation.name} from ${source}.`;
}

function databaseDocument(catalog, options, schemas) {
  const title = catalog.database || options.source;
  const resource = resourceUri(options.source);
  const frontmatter = {
    id: `okf://${options.bundle}/database`,
    type: "PostgreSQL Database",
    title,
    description: oneLine(catalog.databaseComment) || `PostgreSQL database ${title} from ${options.source}.`,
    resource,
    sources: [{ resource, title: `${options.source} database catalog` }],
    generated: generatedMetadata(options),
    tags: ["postgresql", "database"],
    relations: schemas.map((schema) => ({ type: "contains", target: schemaUri(options.bundle, schema.name) })),
  };
  const body = [
    `# ${oneLine(title)}`,
    "",
    catalog.databaseComment ? String(catalog.databaseComment).trim() : `Database discovered from source \`${options.source}\`.`,
    "",
    catalog.serverVersion ? `PostgreSQL version: \`${catalog.serverVersion}\`` : "PostgreSQL version unavailable.",
    "",
    "# Schemas",
    "",
    schemas.length
      ? schemas.map((schema) => `- [${markdownLinkText(schema.name)}](${schemaFile(schema.name)})`).join("\n")
      : "No schemas were discovered.",
  ].join("\n");
  return { file: "database.md", content: conceptMarkdown(frontmatter, body) };
}

function schemaDocument(catalog, options, schema, relations, enums) {
  const file = schemaFile(schema.name);
  const relationLinks = relations.map((relation) => {
    const target = relationFile(relation);
    const href = path.posix.relative(path.posix.dirname(file), target);
    return `- [${markdownLinkText(relation.name)}](${href}) — ${relationShape(relation).label}`;
  });
  const enumLinks = enums.map((value) => {
    const href = path.posix.relative(path.posix.dirname(file), enumFile(value));
    return `- [${markdownLinkText(value.name)}](${href}) — enum`;
  });
  const frontmatter = {
    id: schemaUri(options.bundle, schema.name),
    type: "PostgreSQL Schema",
    title: schema.name,
    description: oneLine(schema.comment) || `PostgreSQL schema ${schema.name} from ${options.source}.`,
    resource: resourceUri(options.source, schema.name),
    sources: [{ resource: resourceUri(options.source, schema.name), title: `${options.source}.${schema.name}` }],
    generated: generatedMetadata(options),
    tags: ["postgresql", "schema", schema.name],
  };
  if (relations.length || enums.length) {
    frontmatter.relations = [
      ...relations.map((relation) => ({ type: "contains", target: relationUri(options.bundle, relation) })),
      ...enums.map((value) => ({ type: "contains", target: enumUri(options.bundle, value) })),
    ];
  }
  const body = [
    `# ${oneLine(schema.name)}`,
    "",
    schema.comment ? String(schema.comment).trim() : `Schema discovered from source \`${options.source}\`.`,
    "",
    "# Relations",
    "",
    relationLinks.length ? relationLinks.join("\n") : "No supported relations were discovered.",
    "",
    "# Types",
    "",
    enumLinks.length ? enumLinks.join("\n") : "No enum types were discovered.",
  ].join("\n");
  return { file, content: conceptMarkdown(frontmatter, body) };
}

function enumDocument(options, value) {
  const resource = resourceUri(options.source, value.schema, value.name);
  const frontmatter = {
    id: enumUri(options.bundle, value),
    type: "PostgreSQL Enum",
    title: `${value.schema}.${value.name}`,
    description: oneLine(value.comment) || `PostgreSQL enum ${value.schema}.${value.name} from ${options.source}.`,
    resource,
    sources: [{ resource, title: `${options.source}.${value.schema}.${value.name}` }],
    generated: generatedMetadata(options),
    tags: ["postgresql", "enum", value.schema],
    relations: [{ type: "contained_by", target: schemaUri(options.bundle, value.schema) }],
  };
  const values = value.values.map((entry) => `- ${htmlCode(entry)}`);
  const body = [
    `# ${oneLine(value.schema)}.${oneLine(value.name)}`,
    "",
    value.comment ? String(value.comment).trim() : `Enum discovered from source \`${options.source}\`.`,
    "",
    "# Values",
    "",
    values.length ? values.join("\n") : "No enum values were discovered.",
  ].join("\n");
  return { file: enumFile(value), content: conceptMarkdown(frontmatter, body) };
}

function constraintLines(relation, currentFile, byName) {
  if (!relation.constraints.length) return ["No primary, unique, foreign-key, or check constraints were discovered."];
  return relation.constraints.map((constraint) => {
    const columns = constraint.columns.map((name) => `\`${name}\``).join(", ") || "—";
    if (constraint.type === "foreign_key") {
      const target = byName.get(`${constraint.referencedSchema}\u0000${constraint.referencedRelation}`);
      const targetName = `${constraint.referencedSchema}.${constraint.referencedRelation}`;
      const renderedTarget = target
        ? `[${markdownLinkText(targetName)}](${path.posix.relative(path.posix.dirname(currentFile), relationFile(target))})`
        : `\`${targetName}\``;
      const referenced = constraint.referencedColumns.map((name) => `\`${name}\``).join(", ") || "—";
      return `- **${constraint.name}**: foreign key (${columns}) → ${renderedTarget} (${referenced})${constraint.definition ? ` — ${htmlCode(constraint.definition)}` : ""}`;
    }
    return `- **${constraint.name}**: ${constraint.type.replace(/_/g, " ")} (${columns})${constraint.definition ? ` — ${htmlCode(constraint.definition)}` : ""}`;
  });
}

function relationDocument(catalog, options, relation, byName) {
  const shape = relationShape(relation);
  const file = relationFile(relation);
  const resource = resourceUri(options.source, relation.schema, relation.name);
  const foreignTargets = relation.constraints
    .filter((constraint) => constraint.type === "foreign_key")
    .map((constraint) => byName.get(`${constraint.referencedSchema}\u0000${constraint.referencedRelation}`))
    .filter(Boolean);
  const frontmatter = {
    id: relationUri(options.bundle, relation),
    type: shape.type,
    title: `${relation.schema}.${relation.name}`,
    description: relationDescription(options.source, relation),
    resource,
    sources: [{ resource, title: `${options.source}.${relation.schema}.${relation.name}` }],
    generated: generatedMetadata(options),
    tags: ["postgresql", shape.label.replace(/ /g, "-"), relation.schema],
    relations: [
      { type: "contained_by", target: schemaUri(options.bundle, relation.schema) },
      ...foreignTargets.map((target) => ({ type: "foreign_key_to", target: relationUri(options.bundle, target) })),
    ],
  };
  const columnRows = relation.columns.map((column) => [
    column.position,
    htmlCode(column.name),
    htmlCode(column.dataType),
    column.nullable ? "yes" : "no",
    htmlCode(column.default),
    column.identity ? `identity ${column.identity}` : column.generated ? `generated ${column.generated}` : "—",
    tableCell(oneLine(column.comment) || `${column.name} column on ${relation.schema}.${relation.name}.`),
  ].join(" | "));
  const body = [
    `# ${oneLine(relation.schema)}.${oneLine(relation.name)}`,
    "",
    relation.comment ? String(relation.comment).trim() : `${shape.type} discovered from source \`${options.source}\`.`,
    "",
    `Resource: \`${resource}\``,
    "",
    "# Schema",
    "",
    "Position | Column | Type | Nullable | Default | Generation | Description",
    "---: | --- | --- | :---: | --- | --- | ---",
    ...(columnRows.length ? columnRows : ["— | — | — | — | — | — | No columns were discovered."]),
    "",
    "# Constraints",
    "",
    ...constraintLines(relation, file, byName),
  ];
  if (relation.definition) {
    body.push("", "# Definition", "", fenced("sql", relation.definition));
  }
  if (options.includeIndexes !== false) {
    body.push("", "# Indexes", "");
    if (relation.indexes.length) {
      relation.indexes.forEach((index) => body.push(`## ${oneLine(index.name)}`, "", fenced("sql", index.definition), ""));
    } else {
      body.push("No indexes were discovered.");
    }
  }
  return { file, content: conceptMarkdown(frontmatter, body.join("\n")) };
}

function buildBundle(catalog, options = {}) {
  if (!catalog || !Array.isArray(catalog.relations) || !Array.isArray(catalog.schemas)) {
    throw new TypeError("A normalized PostgreSQL catalog is required.");
  }
  const source = String(options.source || "postgres").trim();
  const bundle = String(options.bundle || source).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(source) || !/^[A-Za-z0-9_.-]+$/.test(bundle)) {
    throw new Error("Source and bundle identifiers may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  let generatedAt = null;
  if (options.generatedAt !== undefined && options.generatedAt !== null) {
    const date = options.generatedAt instanceof Date ? options.generatedAt : new Date(options.generatedAt);
    if (Number.isNaN(date.getTime())) throw new Error("generatedAt must be a valid ISO datetime or Date.");
    generatedAt = date.toISOString();
  }
  const config = {
    source,
    bundle,
    includeIndexes: options.includeIndexes !== false,
    generatedAt,
    producerVersion: String(options.producerVersion || packageJson.version),
  };
  const relations = [...catalog.relations].sort((a, b) => `${a.schema}\u0000${a.name}`.localeCompare(`${b.schema}\u0000${b.name}`));
  const enums = [...(Array.isArray(catalog.enums) ? catalog.enums : [])]
    .sort((a, b) => `${a.schema}\u0000${a.name}`.localeCompare(`${b.schema}\u0000${b.name}`));
  const byName = new Map(relations.map((relation) => [`${relation.schema}\u0000${relation.name}`, relation]));
  const schemaMap = new Map(catalog.schemas.map((schema) => [schema.name, schema]));
  relations.forEach((relation) => {
    if (!schemaMap.has(relation.schema)) schemaMap.set(relation.schema, { name: relation.schema, comment: null });
  });
  const schemas = [...schemaMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = new Map();

  const indexLinks = schemas.map((schema) => `- [${markdownLinkText(schema.name)}](${schemaFile(schema.name)})`);
  const indexBody = [
    `# ${source} PostgreSQL catalog`,
    "",
    "# Database",
    "",
    `- [${markdownLinkText(catalog.database || options.source || "PostgreSQL database")}](database.md)`,
  ];
  if (catalog.serverVersion) indexBody.push(`PostgreSQL version: \`${catalog.serverVersion}\``);
  indexBody.push(
    "",
    "# Schemas",
    "",
    indexLinks.length ? indexLinks.join("\n") : "No schemas were discovered.",
  );
  files.set("index.md", conceptMarkdown({ okf_version: "0.2" }, indexBody.join("\n")));

  const database = databaseDocument(catalog, config, schemas);
  files.set(database.file, database.content);

  schemas.forEach((schema) => {
    const document = schemaDocument(
      catalog,
      config,
      schema,
      relations.filter((relation) => relation.schema === schema.name),
      enums.filter((value) => value.schema === schema.name),
    );
    files.set(document.file, document.content);
  });
  enums.forEach((value) => {
    const document = enumDocument(config, value);
    files.set(document.file, document.content);
  });
  relations.forEach((relation) => {
    const document = relationDocument(catalog, config, relation, byName);
    files.set(document.file, document.content);
  });
  return files;
}

module.exports = {
  buildBundle,
  conceptMarkdown,
  databaseDocument,
  enumFile,
  enumUri,
  relationFile,
  relationUri,
  safeSegment,
};
