# MEMO — Northwind nightly batch (customer escalation)

**From:** Marcus Webb, Head of Customer Support  
**To:** Platform engineering  
**Re:** P0 — Northwind Logistics 429 errors  
**Date:** 2026-03-14

---

Hi team,

I am escalating this again because Northwind's VP of Engineering emailed our CEO this morning.

## What happened

Northwind's nightly batch job runs **02:00–04:00 UTC**. During that window they send sustained traffic above their contracted RPM. Last night they saw **429 responses** for the first time since we turned on the new limiter in staging.

Their quote to us: *"If your platform can't handle our contracted operations window, we'll need to revisit the partnership."*

## What I need from engineering

**Northwind must never see a 429 during their batch window.**

I understand there is a quota number on paper. I also understand that Northwind is **60% of our revenue** and their renewal is in six weeks. A literal reading of RPM limits that breaks their batch is not a viable outcome for this company.

## My ask

- Guarantee Northwind's batch window works — every night.
- Do **not** tell me to "spread their requests out." Their ERP controls the schedule; we do not.
- If you need a temporary exception mechanism, fine — but it must be **invisible to the customer**. They should not see errors while we figure out a commercial arrangement.

## What I am *not* asking for

I am not asking you to remove rate limiting for everyone. I am asking you to make sure our biggest customer can operate.

Marcus is on PTO next week. If this is not resolved before then, I am routing all Northwind tickets directly to engineering leadership.

— Marcus
