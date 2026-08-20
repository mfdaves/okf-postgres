---
id: okf://okf-postgres/overview/okf-postgres
type: OKF Product
title: okf-postgres
description: Read-only PostgreSQL metadata producer for deterministic Open Knowledge Format bundles.
tags: [okf, postgresql, producer, metadata]
relations:
  - type: configured_by
    target: repo://src/catalog.js
  - type: configured_by
    target: repo://src/render.js
  - type: configured_by
    target: repo://src/producer.js
  - type: checked_by
    target: repo://test/catalog.test.js
  - type: checked_by
    target: repo://test/render.test.js
---

# okf-postgres

`okf-postgres` reads database, schema, relation, and column descriptions plus identity and generated-column
metadata, enum types, constraints, indexes, comments, and view definitions
through fixed PostgreSQL catalog queries. Extraction uses a read-only
transaction and never reads application rows.

The producer emits ordinary filesystem OKF bundles. Stable source aliases keep
hostnames, usernames, and credentials out of generated resource locators.
Digest-scoped publication refuses unowned collisions or modified generated
files and removes only unchanged files owned by a previous producer run.
Generated concepts identify the versioned producer and extraction time without
claiming independent verification.

The PostgreSQL connection adapter, normalized catalog model, OKF renderer, and
publication boundary remain separate. A side-effect-free producer API returns
sorted OKF 0.2 candidate files to a policy-gated host. `okf-mcp` independently
validates, publishes, and consumes the result while retaining its database-free
runtime boundary.
