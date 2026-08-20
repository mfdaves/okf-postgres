# okf-postgres

`okf-postgres` reads PostgreSQL system catalogs through a read-only connection
and produces an Open Knowledge Format v0.2 bundle with explicit generation
provenance.

It documents the database, schemas, tables, partitioned tables, views, materialized views,
foreign tables, columns, identity and generated columns, enum types,
constraints, indexes, comments, and foreign-key relationships. It never reads
application rows and never stores credentials in the bundle.

## Status

The repository contains the focused v1 foundation: catalog extraction,
deterministic bundle generation, owned-file cleanup, a CLI, and mock-backed
coverage. Version `0.1.x` is used until the live PostgreSQL compatibility gate
has been exercised across the supported server versions.

The repository's own architectural reference is a single bundle rooted at
`okf/okf-postgres`. The bundle-named directory preserves the canonical
`okf://okf-postgres/...` workspace identity without an extra `bundles/` layer.

## Install

```bash
npm install --global @mfdaves/okf-postgres
```

Node.js 22 or newer is required.

## Generate a bundle

Keep the connection URL in an environment variable. The command receives only
the variable name:

```bash
export OKF_PG_URL='postgresql://user:password@localhost:5432/app'

okf-postgres generate \
  --connection-env OKF_PG_URL \
  --source app-db \
  --schema public \
  --out ./postgres-okf
```

Repeat `--schema` to include multiple schemas. When omitted, `public` is used.
`--source` is a stable, non-secret alias used in concept identifiers and
`postgresql://` resource locators.

Use `--all-schemas` instead of `--schema` to include every accessible
non-system schema. The producer records `generated.by` with its package version
and `generated.at` with the extraction time. It deliberately does not claim
`verified`; extraction and OKF validation are not independent verification.
Database, schema, relation, and column comments are preserved as descriptions.
When PostgreSQL has no comment, the producer emits a structural fallback and
never invents business meaning.

Useful options:

```text
--bundle <id>            OKF bundle id; defaults to the source alias
--schema <name>          Schema to include; repeatable
--all-schemas            Include accessible non-system schemas
--no-indexes             Exclude index definitions
--catalog-file <path>    Generate from a normalized catalog JSON fixture
--dry-run                Extract and render without publishing files
```

`--catalog-file` supports reproducible development and demonstrations without a
database. It does not accept raw SQL results; the file must follow the
normalized catalog shape returned by `readCatalog`.

## Output

The producer writes:

```text
index.md
database.md
schemas/<schema>.md
tables/<schema>/<table>.md
views/<schema>/<view>.md
types/<schema>/<enum>.md
.okf-producer.json
```

The shared producer manifest records the producer, version, bundle, and SHA-256
digest of every owned file. Publication refuses first-run collisions and
modified owned files before writing anything. A later run removes a stale file
only when its current digest still matches the manifest. Hand-authored files
are preserved.

## Producer API

The package exports `okfProducer` and the compatibility alias
`postgresProducer` for hosts such as `okf-mcp`. The descriptor declares producer
API version 1, OKF version 0.2, and the semantic relation types it emits. Its
configuration accepts only `connectionEnv`, `source`, `schemas`, `allSchemas`,
and `includeIndexes`.

```js
const { okfProducer } = require("@mfdaves/okf-postgres");

const result = await okfProducer.generate({
  bundleId: "app-db",
  generatedAt: new Date().toISOString(),
  config: {
    connectionEnv: "OKF_PG_URL",
    source: "app-db",
    schemas: ["public"],
    includeIndexes: true,
  },
  getSecret: (name) => process.env[name],
});
```

`generate()` returns sorted `{ path, content }` files and a numeric summary. It
does not write files. Host policy, OKF 0.2 validation, preview/apply gates,
publication, and reindexing remain `okf-mcp` responsibilities. The standalone
CLI wraps the same extraction and rendering code with filesystem publication.
Output paths, raw connection strings, SQL, dry-run flags, and catalog fixture
paths are intentionally not producer configuration.

## Development

```bash
npm install
npm test
npm run smoke
npm run coverage
npm run pack:check
```

The test suite uses a PostgreSQL catalog mock. `npm run smoke` requires the
sibling `../okf-mcp` checkout and fails unless that validator accepts the
generated bundle as OKF 0.2.

The guarded live gate only seeds a database named `okf_test`:

```bash
OKF_POSTGRES_LIVE_TEST=1 \
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/okf_test \
npm run live:smoke
```

## V1 evidence

The mock represents the common application-catalog path and the automated gate
covers the following behavior:

| User need | Evidence |
| --- | --- |
| Database, schema, table, view, and column descriptions | Catalog and rendering tests |
| Columns, defaults, nullability, identity, and generated columns | Catalog and rendering tests |
| PostgreSQL enum types and values | Catalog fixture and rendering test |
| Primary, unique, foreign-key, and check constraints | Catalog fixture and relationship rendering tests |
| Index definitions and view SQL | Rendering tests |
| Multiple schemas, cross-schema foreign keys, and optional indexes | Catalog and rendering tests |
| All accessible user schemas and no-write preview | CLI/catalog and producer tests |
| Stable output and unusual quoted identifiers | Determinism and path tests |
| Dropped database objects | Digest-checked manifest cleanup test |
| Collisions, modified output, and hand-authored files | Publication preflight tests |
| Conformant OKF output | Mock smoke bundle validated by sibling `okf-mcp` |
| Publishable npm contents | `npm run pack:check` |

The supported v0.1 range is PostgreSQL 14–18. CI runs the representative live
fixture against PostgreSQL 14 and 18 and runs unit/smoke gates on Node.js 22 and
24. Live integration is a release gate rather than a dependency of every local
unit-test run.

## Security boundary

- Catalog queries are fixed `SELECT` statements.
- Extraction runs in a repeatable-read, read-only transaction.
- Table rows and sample values are never queried.
- Connection URLs are read from environment variables and are never rendered.
- Generated resource locators contain the configured source alias, not the
  server hostname or username.
