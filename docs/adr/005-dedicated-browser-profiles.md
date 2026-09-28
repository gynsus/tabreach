# ADR 005 — Dedicated managed browser profiles

**Status:** Accepted

## Context

Using a person's everyday Chrome profile creates security, lifecycle and debugging problems. Modern Chrome remote-debugging behaviour also favors dedicated data directories.

## Decision

Each automated identity uses a product-managed dedicated browser profile directory.

The user authenticates visibly in that profile.

## Consequences

Session continuity is preserved without importing the main browser profile.

Profile directories are treated as sensitive credential-equivalent data.
