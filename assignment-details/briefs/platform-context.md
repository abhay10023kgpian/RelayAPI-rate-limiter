# RelayAPI platform context (wiki excerpt)

*Internal engineering wiki — not customer-facing.*

## Traffic and topology

| Fact | Detail |
| ---- | ------ |
| App tier | 3 stateless nodes behind round-robin LB |
| Data stores | Postgres (billing, config), Redis (cache — **may or may not** be available in your slice; do not assume ops will provision new infra for a prototype) |
| Request path | TLS termination at LB → app node → upstream API handlers |
| Customer identity | `X-Customer-Id` header (trusted from API gateway today) |

Nodes do not share memory. A request has no affinity to a particular node unless we add it later.

## Customer tiers (simplified)

| Tier | RPM | Notes |
| ---- | --- | ----- |
| Starter | 60 | Long tail of small customers |
| Growth | 300 | Default new signup |
| Enterprise | custom | Negotiated; Northwind is Enterprise |

## Northwind Logistics

- **~60% of ARR.** Renewal conversation active; CEO involved.
- Contracted **300 RPM** Enterprise tier.
- Nightly batch **02:00–04:00 UTC**: sustained **~800–1200 RPM** for 90–120 minutes depending on queue depth.
- Batch is business-critical; retries on 429 amplify load (their client retries aggressively).
- Northwind's engineering contact has said they will not re-architect their scheduler before renewal.

## Known pain points

1. **Previous limiter (deprecated):** did not correctly enforce limits under load-balanced distribution. Decommissioned after it allowed traffic well above contracted quota in production.
2. **Staging incident:** new limiter prototype had correctness issues at quota boundaries under Northwind-scale traffic. Rolled back before GA.
3. **Compliance ask:** enterprise prospects want a one-paragraph explanation of counting semantics for their security review.

## What "GA" means here

A thin vertical slice: one endpoint (e.g. `GET /api/v1/ping` or a mock resource), real limiter middleware, config for at least two fake customer IDs including a stand-in for Northwind, and a harness that can simulate multi-node deployment (processes, containers, or documented equivalent).

Full billing integration, dashboard, and dynamic config UI are **out of scope** for the hiring exercise.
