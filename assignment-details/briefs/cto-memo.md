# MEMO — Per-customer rate limiting (engineering directive)

**From:** Priya Nair, CTO  
**To:** Platform engineering  
**Re:** Quota enforcement for GA launch  
**Date:** 2026-03-14

---

Team,

We are two sprints from GA. Billing is wired to per-customer RPM tiers. Legal has signed off on the SLA language: **a customer must never exceed their contracted quota**. Not "mostly," not "on average" — **never**.

## Requirements (non-negotiable from my side)

1. **Hard enforcement.** When a customer hits their RPM limit, return `429 Too Many Requests` with a `Retry-After` header. No soft warnings, no "we'll bill you extra" path in v1.
2. **Per-customer isolation.** Customer A's traffic spike must not consume Customer B's budget. Shared pools are out.
3. **Strictly fair metering.** Two customers on the same tier must get the same treatment. No hidden bypasses, no manual overrides in code paths that production traffic hits.
4. **Auditable.** We need to explain to an enterprise prospect *exactly* how we counted their requests. "It's complicated" is not an answer.

## Technical context I care about

- We run **three stateless app nodes** today. Whatever you build must work when requests land on different nodes between seconds.
- I am fine with **eventual consistency** as long as the error direction is **under-limiting, not over-limiting**. I would rather reject a few extra legitimate requests than let someone blow past quota because nodes disagreed.
- Pick a well-understood algorithm. I do not want a bespoke counter unless you can prove it.

## What I do not want

- A rate limiter that only works in a single process and gets deployed three times with fingers crossed.
- "We'll fix distributed state in v2." Not acceptable for GA.
- Special-case hacks buried in `if (customerId === ...)` blocks. If we ever grant a commercial exception, it goes through config and audit — not a midnight commit.

## Success criteria

Show me a demo where two customers on a 100 RPM tier each get exactly their budget, and a third customer who exceeds 100 RPM gets cut off — **even when I hammer the load balancer randomly across all three nodes**.

— Priya
