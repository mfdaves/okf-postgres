"use strict";

const DATABASE_SQL = `
/* okf-postgres:database */
SELECT current_database() AS database_name,
       current_setting('server_version') AS server_version,
       shobj_description(d.oid, 'pg_database') AS comment
FROM pg_database d
WHERE d.datname = current_database()
`;

const SCHEMAS_SQL = `
/* okf-postgres:schemas */
SELECT n.nspname AS schema_name,
       obj_description(n.oid, 'pg_namespace') AS comment
FROM pg_namespace n
WHERE n.nspname = ANY($1::text[])
ORDER BY n.nspname
`;

const ALL_SCHEMAS_SQL = `
/* okf-postgres:allschemas */
SELECT n.nspname AS schema_name,
       obj_description(n.oid, 'pg_namespace') AS comment
FROM pg_namespace n
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
  AND has_schema_privilege(n.oid, 'USAGE')
ORDER BY n.nspname
`;

const RELATIONS_SQL = `
/* okf-postgres:relations */
SELECT c.oid::text AS relation_oid,
       n.nspname AS schema_name,
       c.relname AS relation_name,
       CASE c.relkind
         WHEN 'r' THEN 'table'
         WHEN 'p' THEN 'partitioned_table'
         WHEN 'v' THEN 'view'
         WHEN 'm' THEN 'materialized_view'
         WHEN 'f' THEN 'foreign_table'
       END AS relation_kind,
       obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS view_definition
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = ANY($1::text[])
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
ORDER BY n.nspname, c.relname
`;

const COLUMNS_SQL = `
/* okf-postgres:columns */
SELECT c.oid::text AS relation_oid,
       n.nspname AS schema_name,
       c.relname AS relation_name,
       a.attnum AS ordinal_position,
       a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS is_nullable,
       pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
       a.attidentity AS identity_kind,
       a.attgenerated AS generated_kind,
       col_description(a.attrelid, a.attnum) AS comment
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = ANY($1::text[])
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY n.nspname, c.relname, a.attnum
`;

const CONSTRAINTS_SQL = `
/* okf-postgres:constraints */
SELECT con.conrelid::text AS relation_oid,
       n.nspname AS schema_name,
       c.relname AS relation_name,
       con.conname AS constraint_name,
       CASE con.contype
         WHEN 'p' THEN 'primary_key'
         WHEN 'u' THEN 'unique'
         WHEN 'f' THEN 'foreign_key'
         WHEN 'c' THEN 'check'
       END AS constraint_type,
       ARRAY(
         SELECT a.attname
         FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, position)
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = key.attnum
         ORDER BY key.position
       ) AS columns,
       rn.nspname AS referenced_schema,
       rc.relname AS referenced_relation,
       CASE WHEN con.contype = 'f' THEN ARRAY(
         SELECT a.attname
         FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, position)
         JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = key.attnum
         ORDER BY key.position
       ) END AS referenced_columns,
       pg_get_constraintdef(con.oid, true) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class rc ON rc.oid = con.confrelid
LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE n.nspname = ANY($1::text[])
  AND con.contype IN ('p', 'u', 'f', 'c')
ORDER BY n.nspname, c.relname, con.conname
`;

const INDEXES_SQL = `
/* okf-postgres:indexes */
SELECT schemaname AS schema_name,
       tablename AS relation_name,
       indexname AS index_name,
       indexdef AS definition
FROM pg_indexes
WHERE schemaname = ANY($1::text[])
ORDER BY schemaname, tablename, indexname
`;

const ENUMS_SQL = `
/* okf-postgres:enums */
SELECT n.nspname AS schema_name,
       t.typname AS type_name,
       obj_description(t.oid, 'pg_type') AS comment,
       array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE n.nspname = ANY($1::text[])
GROUP BY n.nspname, t.typname, t.oid
ORDER BY n.nspname, t.typname
`;

function selectedSchemas(options) {
  const values = Array.isArray(options && options.schemas) && options.schemas.length
    ? options.schemas
    : ["public"];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

function relationKey(schema, name) {
  return `${schema}\u0000${name}`;
}

async function rows(client, text, schemas) {
  const result = await client.query({ text, values: schemas ? [schemas] : [] });
  return Array.isArray(result && result.rows) ? result.rows : [];
}

async function readCatalog(client, options = {}) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("A PostgreSQL-compatible client with query() is required.");
  }
  const requestedSchemas = selectedSchemas(options);
  const databaseRows = await rows(client, DATABASE_SQL);
  const schemaRows = options.allSchemas
    ? await rows(client, ALL_SCHEMAS_SQL)
    : await rows(client, SCHEMAS_SQL, requestedSchemas);
  if (!schemaRows.length) {
    throw new Error("No accessible PostgreSQL schemas matched the selection.");
  }
  if (!options.allSchemas) {
    const found = new Set(schemaRows.map((row) => String(row.schema_name)));
    const missing = requestedSchemas.filter((schema) => !found.has(schema));
    if (missing.length) {
      throw new Error(`Requested PostgreSQL schemas were not found or accessible: ${missing.join(", ")}.`);
    }
  }
  const schemas = schemaRows.map((row) => String(row.schema_name));
  const relationRows = await rows(client, RELATIONS_SQL, schemas);
  const columnRows = await rows(client, COLUMNS_SQL, schemas);
  const constraintRows = await rows(client, CONSTRAINTS_SQL, schemas);
  const indexRows = options.includeIndexes === false ? [] : await rows(client, INDEXES_SQL, schemas);
  const enumRows = await rows(client, ENUMS_SQL, schemas);

  const relations = relationRows.map((row) => ({
    oid: String(row.relation_oid),
    schema: String(row.schema_name),
    name: String(row.relation_name),
    kind: String(row.relation_kind),
    comment: row.comment || null,
    definition: row.view_definition || null,
    columns: [],
    constraints: [],
    indexes: [],
  }));
  const byName = new Map(relations.map((relation) => [relationKey(relation.schema, relation.name), relation]));

  columnRows.forEach((row) => {
    const relation = byName.get(relationKey(row.schema_name, row.relation_name));
    if (!relation) return;
    relation.columns.push({
      position: Number(row.ordinal_position),
      name: String(row.column_name),
      dataType: String(row.data_type),
      nullable: Boolean(row.is_nullable),
      default: row.column_default || null,
      identity: row.identity_kind === "a" ? "always" : row.identity_kind === "d" ? "by default" : null,
      generated: row.generated_kind === "s" ? "stored" : row.generated_kind === "v" ? "virtual" : null,
      comment: row.comment || null,
    });
  });

  constraintRows.forEach((row) => {
    const relation = byName.get(relationKey(row.schema_name, row.relation_name));
    if (!relation) return;
    relation.constraints.push({
      name: String(row.constraint_name),
      type: String(row.constraint_type),
      columns: Array.isArray(row.columns) ? row.columns.map(String) : [],
      referencedSchema: row.referenced_schema || null,
      referencedRelation: row.referenced_relation || null,
      referencedColumns: Array.isArray(row.referenced_columns) ? row.referenced_columns.map(String) : [],
      definition: row.definition || null,
    });
  });

  indexRows.forEach((row) => {
    const relation = byName.get(relationKey(row.schema_name, row.relation_name));
    if (!relation) return;
    relation.indexes.push({
      name: String(row.index_name),
      definition: String(row.definition),
    });
  });

  const database = databaseRows[0] || {};
  return {
    database: database.database_name ? String(database.database_name) : null,
    databaseComment: database.comment || null,
    serverVersion: database.server_version ? String(database.server_version) : null,
    schemas: schemaRows.map((row) => ({ name: String(row.schema_name), comment: row.comment || null })),
    enums: enumRows.map((row) => ({
      schema: String(row.schema_name),
      name: String(row.type_name),
      comment: row.comment || null,
      values: Array.isArray(row.values) ? row.values.map(String) : [],
    })),
    relations,
  };
}

module.exports = {
  DATABASE_SQL,
  SCHEMAS_SQL,
  ALL_SCHEMAS_SQL,
  RELATIONS_SQL,
  COLUMNS_SQL,
  CONSTRAINTS_SQL,
  INDEXES_SQL,
  ENUMS_SQL,
  readCatalog,
  selectedSchemas,
};
