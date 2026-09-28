# ADR 010 — Browser Runtime uses an explicit process boundary

**Status:** Superseded by ADR 012 (2026-09-28)

## Original context and decision

A future SaaS version might place the control plane in the cloud while the browser runtime stays on the user's machine; therefore API and runtime would communicate through an authenticated, versioned local network protocol from day one.

## Why superseded

The product will not have a cloud control plane (ADR 001, revised). The process boundary between domain logic and browser automation is kept — for crash isolation and testability — but it is now an in-app IPC boundary (MessagePort / host IPC channel) between Electron-managed processes with no network protocol, authentication tokens or ports. See ADR 012.

Note on the original design: had a cloud control plane remained a goal, the connection direction would also have been wrong (a cloud API cannot call into a runtime behind NAT; the runtime must dial out).
