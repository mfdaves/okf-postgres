# Project Agent Rules

## Product Boundary

`okf-postgres` is a read-only PostgreSQL metadata producer. It emits ordinary
Open Knowledge Format bundles and never stores OKF state in PostgreSQL, reads
table rows, or executes SQL supplied by bundle content.

Keep connection secrets outside configuration and generated output. Accept an
environment-variable name, not an inline connection string, in persisted
configuration or examples.

## Implementation

- Keep catalog extraction, OKF rendering, filesystem publication, and CLI
  concerns separate.
- Prefer deterministic output and stable concept paths.
- Generated-file deletion must be limited to paths recorded in the producer
  manifest.
- Keep the runtime small. Add modules only when they establish a real boundary.

## Validation

Run `npm test`, `npm run smoke`, and `npm run pack:check`. The normal test suite
uses the catalog mock and must not require a live PostgreSQL server. When a live
database is used for additional verification, report it separately.
