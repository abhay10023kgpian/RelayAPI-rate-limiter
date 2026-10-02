# Promise Them Nothing Twice

A take-home assignment for harness engineering and agentic system design.

---

## Scenario

You have joined **RelayAPI**, a fictional B2B API platform. RelayAPI sells metered HTTP APIs to other companies. Each customer has a contracted requests-per-minute (RPM) quota. Traffic is routed across **three stateless application nodes** behind a load balancer; there is no sticky sessions requirement today.

RelayAPI's largest customer — **Northwind Logistics** — accounts for roughly **60% of recurring revenue**. They run a nightly batch job between **02:00–04:00 UTC** that spikes traffic far above their contracted RPM. Losing Northwind would be an existential event for the company.

Two stakeholders have given you conflicting instructions. Both believe their requirement is non-negotiable. Neither has authority over the other.

**Read the source memos** (linked below). They are the assignment. Do not treat this page as a cleaned-up spec that replaces them — the tension between the memos is intentional.

| Document | From |
| -------- | ---- |
| [CTO memo](briefs/cto-memo.md) | Priya Nair, CTO |
| [Support lead memo](briefs/support-lead-memo.md) | Marcus Webb, Head of Customer Support |
| [Platform context](briefs/platform-context.md) | Engineering wiki excerpt |

Your job is not to make both memos literally true. Your job is to **resolve the conflict explicitly**, build a thin vertical slice that reflects your resolution, and **prove your limiter behaves correctly at the boundary** — including the places where naive implementations are wrong.

---

## What you are building

There is **no starter repository**. You choose the language, framework, and dependencies. We expect a **thin working service** plus a **load-generating harness** you write or direct an agent to write.

At minimum, your solution must include:

1. **A rate-limiting HTTP API** (or middleware) that enforces per-customer limits. It should run realistically on multiple instances — not a single-process demo that only works on one machine.
2. **A documented algorithm choice** — token bucket, sliding window, fixed window, leaky bucket, or a hybrid — with reasoning tied to RelayAPI's constraints (fairness, burst behavior, distributed coordination).
3. **A load harness** that drives the service at quota boundaries and reports results in a legible way (stdout tables, JSON report, or similar). The harness is a first-class deliverable, not an afterthought.
4. **Demonstrations of boundary behavior.** Your harness output should make correct or incorrect behavior obvious without us reading your implementation.

You decide how much to build beyond this. A strong submission is narrow, verified, and honest about tradeoffs — not feature-complete.

---

## Deliverables

Submit everything below. Incomplete submissions are acceptable if your `DECISIONS.md` says what is missing and what you would do next.

### 1. Working artifact (`solution/`)

Your rate limiter service and load harness. Include:

- `README.md` with setup and how to run the service and harness (target: a reviewer can run it in **≤ 15 minutes** on a laptop with only free tools).
- Enough code to demonstrate the behaviors you claim.

### 2. AI session exports (`sessions/`)

**This is the primary deliverable we evaluate.**

Export **every working session** you used to build this assignment — Cursor, Claude Code, Windsurf, Copilot Chat, or any other agentic tool. Each export must include:

- **Your prompts** (what you asked, in full — not summaries you wrote later).
- **The agent's detailed output** — tool calls, reasoning, code diffs, errors, retries. Sanitized marketing screenshots are not substitutes.

**Cursor users:** use *Export Chat* (or equivalent) to produce `.md` files. Name them in chronological order, e.g. `01-framing.md`, `02-distributed-design.md`.

**Other tools:** submit the closest equivalent full transcript. If your tool cannot export, paste raw logs into markdown files. Do not paraphrase the agent's output.

Hiding, heavily editing, or omitting sessions **disqualifies** the submission. We are hiring people who drive AI in the open.

### 3. Decisions note (`DECISIONS.md`)

One page or less. Structured prose, not a novel. Cover:

- What you decided about the CTO vs. support conflict — and what you explicitly rejected.
- Algorithm and distributed-coordination choices.
- What your harness proves and what it does *not* prove.
- What you would build next with another four hours.

---

## AI mandate

**Heavy AI use is required.** Use agents aggressively for implementation, research, and debugging.

The transcript is not a confession — it is your portfolio. We score how you frame problems, pack context the agent cannot know, decompose work, catch bluffs, and recover from failures. A beautiful repo with an empty or sanitized `sessions/` folder tells us nothing useful.

---

## What we evaluate

We read your session exports against a rubric focused on **driving**, not typing:

| Dimension | What we look for |
| --------- | ---------------- |
| **Understanding** | Did you grasp the conflict and constraints before building? |
| **Prompting** | Clear goals, useful context, iterative refinement, recovery from bad agent turns |
| **Critical review** | Catching subtly wrong "distributed" designs, off-by-one windows, tests that prove nothing |
| **Debugging** | Systematic diagnosis when harness and service disagree |
| **Decomposition** | Sequenced work — not one giant "build me a distributed rate limiter" prompt |
| **Communication** | A reviewer can follow your intent from the exports alone |

We do **not** grade variable names, micro-optimizations, or framework fashion. Agents already do that better than we can manually.

---

## Timebox and definition of done

| | |
| --- | --- |
| **Expected effort** | 4–6 hours |
| **Hard cap** | One weekend from when you receive this assignment |
| **Done enough** | Runnable service + harness + honest `DECISIONS.md` + complete session exports |

Submitting unfinished work with a clear "here is what I would do next" is **better signal** than a rushed façade of completeness. Death-marches to fake polish are noise.

---

## Submission logistics

Follow these steps exactly. Ambiguity here is unfair; ambiguity in the stakeholder memos is the assignment.

1. **Fork** this repository to your own GitHub account.
2. Create your submission directory:

   ```
   submissions/<your-github-username>/promise-them-nothing-twice/
   ├── solution/          # service + harness + README
   ├── sessions/          # AI session exports (.md)
   └── DECISIONS.md
   ```

3. **Open a pull request** against the upstream `ti-hiring` repository with your submission. Title format: `[submission] <your-github-username> — Promise Them Nothing Twice`.
4. In the PR description, include:
   - Total time spent (honest estimate).
   - One sentence on the hardest decision you made.
5. **Do not** commit API keys, paid-service credentials, or real customer data. Use fake customer IDs in demos.

If you cannot open a PR (private fork policy, etc.), email a link to your fork and the commit SHA instead — but PR is strongly preferred.

---

## Stakeholder memos

- [CTO memo — "Strictly fair, never exceed quota"](briefs/cto-memo.md)
- [Support lead memo — "Northwind must never see a 429 in batch window"](briefs/support-lead-memo.md)
- [Platform context — nodes, revenue, traffic shape](briefs/platform-context.md)

Good luck. We are looking for someone in command — not a perfect run.
