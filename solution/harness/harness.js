#!/usr/bin/env node
/**
 * RelayAPI Load Harness
 * ─────────────────────
 * What this is:
 *   A load-generating test script that fires controlled bursts of HTTP
 *   requests at the rate-limiter service and compares actual outcomes
 *   (allowed vs rejected) against what the sliding-window algorithm
 *   should produce. Prints a visual ASCII report to stdout.
 *
 * What it proves:
 *   ✓ Under-quota traffic passes through cleanly
 *   ✓ Over-quota traffic is cut off at exactly the right boundary
 *   ✓ Two customers on the same tier do NOT eat each other's quota
 *   ✓ Load is distributed across all three nodes (round-robin visible)
 *   ✓ Northwind's contracted 300 RPM is enforced — no free pass
 *
 * What it does NOT prove:
 *   ✗ Clock skew between nodes (all in Docker, shared clock)
 *   ✗ Redis failure / split-brain behaviour
 *   ✗ Retry amplification loop (clean load only)
 *
 * Zero external dependencies — pure Node.js stdlib.
 */

'use strict';

const http = require('http');

const BASE_URL   = process.env.BASE_URL   || 'http://localhost:8080';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed:   '\x1b[41m',
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
function ping(customerId) {
  return new Promise((resolve) => {
    const url = new URL('/api/v1/ping', BASE_URL);
    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method:   'GET',
      headers:  { 'X-Customer-Id': customerId },
    };
    const req = http.request(options, (res) => {
      res.resume(); // drain body
      resolve({
        status:     res.statusCode,
        node:       res.headers['x-served-by']           || 'unknown',
        remaining:  res.headers['x-ratelimit-remaining'] || '?',
        retryAfter: res.headers['retry-after']           || null,
      });
    });
    req.on('error', () => resolve({ status: 0, node: 'error', remaining: '?', retryAfter: null }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, node: 'timeout', remaining: '?', retryAfter: null }); });
    req.end();
  });
}

// ── Burst sender — N requests, bounded concurrency ───────────────────────────
async function burst(customerId, n, concurrency = CONCURRENCY) {
  const results = [];
  const slots   = Array(n).fill(null);

  async function worker() {
    while (slots.length > 0) {
      slots.pop();
      results.push(await ping(customerId));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  return results;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function stats(results) {
  const allowed  = results.filter(r => r.status === 200).length;
  const rejected = results.filter(r => r.status === 429).length;
  const errors   = results.filter(r => r.status !== 200 && r.status !== 429).length;
  const nodes    = {};
  for (const r of results) nodes[r.node] = (nodes[r.node] || 0) + 1;
  return { allowed, rejected, errors, total: results.length, nodes };
}

// ── Render helpers ────────────────────────────────────────────────────────────
const BAR_WIDTH = 24;

function bar(count, total, colour) {
  const filled = total > 0 ? Math.round((count / total) * BAR_WIDTH) : 0;
  return colour + '█'.repeat(filled) + C.dim + '░'.repeat(BAR_WIDTH - filled) + C.reset;
}

function passLabel(ok) {
  return ok
    ? `${C.bgGreen}${C.bold}  PASS  ${C.reset}`
    : `${C.bgRed}${C.bold}  FAIL  ${C.reset}`;
}

function pct(n, total) {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
}

function divider(char = '─', w = 62) { return char.repeat(w); }

function printScenarioHeader(num, title) {
  console.log(`\n${C.cyan}${C.bold}  ┌${divider('─', 58)}┐${C.reset}`);
  console.log(`${C.cyan}${C.bold}  │  Scenario ${num}: ${title.padEnd(46)}│${C.reset}`);
  console.log(`${C.cyan}${C.bold}  └${divider('─', 58)}┘${C.reset}`);
}

function printStats(label, s, expected) {
  const { allowed, rejected, errors, total, nodes } = s;

  console.log(`\n  ${C.bold}${label}${C.reset}`);
  console.log(`  ${C.dim}${divider('·', 54)}${C.reset}`);
  console.log(`  Sent      ${C.bold}${String(total).padStart(4)}${C.reset}  ${bar(total, total, C.white)}`);
  console.log(`  Allowed   ${C.green}${String(allowed).padStart(4)}${C.reset}  ${bar(allowed, total, C.green)}  ${C.green}${pct(allowed, total)}${C.reset}`);
  console.log(`  Rejected  ${C.red}${String(rejected).padStart(4)}${C.reset}  ${bar(rejected, total, C.red)}  ${C.red}${pct(rejected, total)}${C.reset}`);
  if (errors > 0)
    console.log(`  ${C.yellow}Errors    ${String(errors).padStart(4)}${C.reset}  (check service is up)`);

  // Node distribution
  const nodeEntries = Object.entries(nodes).sort(([a], [b]) => a.localeCompare(b));
  if (nodeEntries.length > 0) {
    console.log(`\n  Node distribution:`);
    for (const [node, cnt] of nodeEntries) {
      console.log(`    ${C.cyan}${node.padEnd(12)}${C.reset}  ${bar(cnt, total, C.cyan)}  ${cnt}`);
    }
  }

  // Pass / fail
  const ok = allowed >= expected.minAllowed &&
             allowed <= (expected.maxAllowed ?? Infinity) &&
             rejected >= expected.minRejected &&
             rejected <= (expected.maxRejected ?? Infinity);

  console.log(`\n  Expected  allowed ∈ [${expected.minAllowed}, ${expected.maxAllowed ?? '∞'}]  ` +
              `rejected ∈ [${expected.minRejected}, ${expected.maxRejected ?? '∞'}]`);
  console.log(`  ${passLabel(ok)}`);

  return ok;
}

// ── Connectivity check ────────────────────────────────────────────────────────
async function checkConnectivity() {
  return new Promise((resolve) => {
    const url  = new URL('/health', BASE_URL);
    // Try app1 health directly if through nginx /health isn't rate-limited
    const req  = http.request({ hostname: url.hostname, port: url.port || 80, path: '/health', method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Banner
  console.log(`\n${C.cyan}${C.bold}`);
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║          RelayAPI Rate Limiter — Load Harness            ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log(C.reset);
  console.log(`  ${C.bold}Target   ${C.reset}: ${BASE_URL}`);
  console.log(`  ${C.bold}Started  ${C.reset}: ${new Date().toISOString()}`);
  console.log(`  ${C.bold}Concurrency${C.reset}: ${CONCURRENCY} parallel requests`);

  // Check service is up
  process.stdout.write(`\n  Checking connectivity... `);
  const up = await checkConnectivity();
  if (!up) {
    console.log(`${C.red}✗ FAILED${C.reset}`);
    console.error(`\n  ${C.red}Cannot reach ${BASE_URL}${C.reset}`);
    console.error('  Make sure the stack is running:  docker compose up --build\n');
    process.exit(1);
  }
  console.log(`${C.green}✓ OK${C.reset}`);

  const scenarioResults = [];

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 1 — Under quota
  // Send 80 requests against a 100 RPM limit.
  // Expect: 80 allowed, 0 rejected.
  // Proves: normal traffic is not disturbed.
  // ────────────────────────────────────────────────────────────────────────────
  printScenarioHeader(1, 'Under Quota — 80 req vs limit 100');
  {
    const r = stats(await burst('harness-sc1', 80));
    scenarioResults.push(printStats(
      'customer-alpha-like | 80 req | limit=100 RPM',
      r,
      { minAllowed: 80, maxAllowed: 80, minRejected: 0, maxRejected: 0 }
    ));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 2 — Exactly at quota boundary
  // Send 100 requests against a 100 RPM limit.
  // Expect: 100 allowed, 0 rejected.
  // Proves: the 100th request is accepted (limit is inclusive).
  // ────────────────────────────────────────────────────────────────────────────
  printScenarioHeader(2, 'At Quota Boundary — 100 req vs limit 100');
  {
    const r = stats(await burst('harness-sc2', 100));
    scenarioResults.push(printStats(
      '100 req | limit=100 RPM | 100th request must be allowed',
      r,
      { minAllowed: 100, maxAllowed: 100, minRejected: 0, maxRejected: 0 }
    ));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 3 — Over quota
  // Send 130 requests against a 100 RPM limit.
  // Expect: ~100 allowed, ~30 rejected.
  // Proves: the limiter cuts off at the right boundary, not before, not after.
  // ────────────────────────────────────────────────────────────────────────────
  printScenarioHeader(3, 'Over Quota Boundary — 130 req vs limit 100');
  {
    const r = stats(await burst('harness-sc3', 130));
    scenarioResults.push(printStats(
      '130 req | limit=100 RPM | ~100 allowed, ~30 rejected',
      r,
      { minAllowed: 98, maxAllowed: 102, minRejected: 28 }
    ));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 4 — Customer isolation
  // Two separate customers, each firing 80 requests, concurrently.
  // Expect: both get 80 allowed, 0 rejected.
  // Proves: Customer A's traffic does not consume Customer B's quota.
  // ────────────────────────────────────────────────────────────────────────────
  printScenarioHeader(4, 'Customer Isolation — two customers, 80 req each, concurrent');
  {
    const [rawA, rawB] = await Promise.all([
      burst('harness-sc4a', 80),
      burst('harness-sc4b', 80),
    ]);
    const rA = stats(rawA);
    const rB = stats(rawB);
    const pA = printStats('Customer A: 80 req | limit=100 | expect 0 rejected', rA,
      { minAllowed: 80, maxAllowed: 80, minRejected: 0, maxRejected: 0 });
    const pB = printStats('Customer B: 80 req | limit=100 | expect 0 rejected', rB,
      { minAllowed: 80, maxAllowed: 80, minRejected: 0, maxRejected: 0 });
    scenarioResults.push(pA && pB);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 5 — Node distribution
  // Send 90 requests through nginx (round-robin).
  // Expect: traffic roughly split across 3 nodes (~30 each ± 15).
  // Proves: all three nodes share the load; no node is dead.
  // NOTE: Quota is still enforced correctly despite node spread — that's the
  //       point. Redis is the shared counter, not per-node memory.
  // ────────────────────────────────────────────────────────────────────────────
  printScenarioHeader(5, 'Round-Robin Node Distribution — 90 req');
  {
    const raw = await burst('harness-sc5', 90);
    const r   = stats(raw);
    console.log(`\n  ${C.bold}90 requests via nginx round-robin${C.reset}`);
    console.log(`  ${C.dim}${'·'.repeat(54)}${C.reset}`);
    const entries = Object.entries(r.nodes).sort(([a], [b]) => a.localeCompare(b));
    for (const [node, cnt] of entries) {
      console.log(`  ${C.cyan}${node.padEnd(14)}${C.reset}  ${bar(cnt, 90, C.cyan)}  ${C.bold}${cnt}${C.reset} req`);
    }
    const counts  = Object.values(r.nodes);
    const maxNode = Math.max(...counts);
    const minNode = Math.min(...counts);
    const spread  = maxNode - minNode;
    const nodeCount = entries.length;
    const balanced  = nodeCount >= 3 && spread <= 18; // ±18 tolerance for OS scheduling jitter
    console.log(`\n  Nodes seen: ${C.bold}${nodeCount}${C.reset}  |  spread: ${C.bold}${spread}${C.reset} (max-min, expect ≤ 18)`);
    console.log(`  ${passLabel(balanced)}`);
    scenarioResults.push(balanced);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 6 — Northwind at contracted rate
  // 250 requests against Northwind's 300 RPM contract.
  // Expect: 250 allowed, 0 rejected.
  // Proves: contracted quota is sufficient for normal sub-limit traffic.
  // ────────────────────────────────────────────────────────────────────────────
  printScenarioHeader(6, 'Northwind — At Contracted Rate (250 req vs limit 300)');
  {
    const r = stats(await burst('harness-nw1', 250));
    scenarioResults.push(printStats(
      'northwind | 250 req | limit=300 RPM',
      r,
      { minAllowed: 250, maxAllowed: 250, minRejected: 0, maxRejected: 0 }
    ));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Scenario 7 — Northwind over contracted quota
  // 400 requests against Northwind's 300 RPM contract.
  // Expect: ~300 allowed, ~100 rejected.
  // Proves: without batch-window override, Northwind IS rate limited.
  // This is the baseline before Stakeholder 2 (batch window) is added.
  // These 429s are what Marcus Webb is escalating about.
  // ────────────────────────────────────────────────────────────────────────────
  printScenarioHeader(7, 'Northwind — Over Contracted Quota (400 req vs limit 300)');
  {
    const r = stats(await burst('harness-nw2', 400));
    scenarioResults.push(printStats(
      'northwind | 400 req | limit=300 RPM | CTO enforcement active',
      r,
      { minAllowed: 295, maxAllowed: 305, minRejected: 95 }
    ));
    console.log(`\n  ${C.yellow}⚠  These 429s are what Marcus Webb escalated.`);
    console.log(`     The batch-window override (Stakeholder 2) resolves this.${C.reset}`);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  const passed = scenarioResults.filter(Boolean).length;
  const total  = scenarioResults.length;
  const allOk  = passed === total;

  console.log(`\n${C.bold}${allOk ? C.green : C.red}`);
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log(`  ║  SUMMARY : ${String(passed).padStart(2)} / ${total} scenarios passed${' '.repeat(32 - String(passed + '/' + total).length)}║`);
  console.log(`  ║  Result  : ${allOk ? '✓ ALL PASS' : '✗ SOME FAILED'}${' '.repeat(allOk ? 39 : 38)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log(C.reset);

  // Per-scenario summary table
  const labels = [
    'Sc1  Under quota (80 req, limit 100)',
    'Sc2  At quota boundary (100 req, limit 100)',
    'Sc3  Over quota (130 req, limit 100)',
    'Sc4  Customer isolation (2×80 req)',
    'Sc5  Round-robin node distribution',
    'Sc6  Northwind at contracted rate (250 req)',
    'Sc7  Northwind over quota (400 req)',
  ];
  for (let i = 0; i < scenarioResults.length; i++) {
    const ok  = scenarioResults[i];
    const sym = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
    console.log(`  ${sym}  ${labels[i]}`);
  }
  console.log();

  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error(`\n${C.red}Harness crashed:${C.reset}`, err.message);
  console.error('Is the service up?  docker compose up --build\n');
  process.exit(1);
});
