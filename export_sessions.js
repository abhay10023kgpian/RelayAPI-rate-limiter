/**
 * Converts Antigravity IDE transcript.jsonl into chronological
 * session markdown files for the sessions/ deliverable.
 *
 * Usage: node export_sessions.js
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const TRANSCRIPT = path.join(
  'C:\\Users\\abhay\\.gemini\\antigravity-ide\\brain',
  '9c12cffd-4759-4768-b1b1-0369f008a4c4',
  '.system_generated\\logs\\transcript_full.jsonl'
);
const OUT_DIR = path.join(__dirname, 'sessions');

// ── Session boundaries (by topic, chronological) ────────────────────────────
// Each session groups related user prompts into a logical phase of work.
const SESSIONS = [
  {
    file: '01-framing-and-conflict-resolution.md',
    title: 'Framing, Conflict Resolution & Algorithm Choice',
    startStep: 0,
    endStep: 34,
    summary: 'Initial analysis of the CTO vs Support conflict. Chose sliding window counter over token bucket. Decided on elevated batch ceiling of 1500 RPM for Northwind during 02:00–04:00 UTC window.',
  },
  {
    file: '02-infrastructure-and-first-stakeholder.md',
    title: 'Docker Infrastructure & First Stakeholder (CTO) Implementation',
    startStep: 35,
    endStep: 101,
    summary: 'Built the three-node Docker stack (app + Redis + Nginx LB). Implemented the sliding window rate limiter with Lua-backed atomic counters. Built harness.js with initial scenarios. Debugged Nginx config issues.',
  },
  {
    file: '03-northwind-batch-window.md',
    title: 'Northwind Batch Window & DECISIONS.md',
    startStep: 102,
    endStep: 142,
    summary: 'Added batch window override for Northwind (1500 RPM during 02:00–04:00 UTC). Expanded harness to 10 scenarios including batch over/under ceiling. Updated DECISIONS.md with algorithm rationale and parameter choices.',
  },
  {
    file: '04-grace-period-and-edge-cases.md',
    title: 'Grace Period, Edge Cases & Redis Time',
    startStep: 143,
    endStep: 219,
    summary: 'Identified the 429 cliff at batch window boundaries. Implemented three-regime system (batch/grace/normal) with separate Redis keys and linear ramp-down. Built harness2.js for real-time testing. Switched all time to Redis TIME command for stateless clock.',
  },
  {
    file: '05-redis-fallback-and-circuit-breaker.md',
    title: 'Redis Fallback, Circuit Breaker & Documentation',
    startStep: 220,
    endStep: Infinity,
    summary: 'Discussed Redis HA options. Implemented local split-quota fallback with circuit breaker for graceful degradation. Fixed ioredis offline queue timeout issue. Documented transition overshoot tradeoff. Wrote final README and DECISIONS.md.',
  },
];

// ── Parse transcript ────────────────────────────────────────────────────────
const lines = fs.readFileSync(TRANSCRIPT, 'utf8').trim().split('\n');
const steps = lines.map((l, i) => {
  try { return JSON.parse(l); }
  catch { return { step_index: i, type: 'PARSE_ERROR', content: '' }; }
});

// ── Generate session files ──────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const session of SESSIONS) {
  const relevant = steps.filter(s =>
    s.step_index >= session.startStep &&
    s.step_index <= session.endStep &&
    (s.type === 'USER_INPUT' || s.type === 'PLANNER_RESPONSE')
  );

  let md = `# ${session.title}\n\n`;
  md += `> **Session summary:** ${session.summary}\n\n`;
  md += `---\n\n`;

  for (const step of relevant) {
    const time = step.created_at || '';

    if (step.type === 'USER_INPUT') {
      // Extract just the user request content
      let content = step.content || '';
      // Clean up XML tags for readability
      const reqMatch = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
      const userText = reqMatch ? reqMatch[1].trim() : content.trim();

      // Also extract any user actions (file views, commands, etc.)
      const actionParts = [];
      const actionMatches = content.matchAll(/The USER performed the following action:\s*([\s\S]*?)(?=<USER_REQUEST>|The USER performed|$)/g);
      for (const m of actionMatches) {
        actionParts.push(m[1].trim());
      }

      md += `## 🧑 User — ${time}\n\n`;
      if (actionParts.length > 0) {
        for (const a of actionParts) {
          md += `> *User action:*\n> ${a.split('\n').join('\n> ')}\n\n`;
        }
      }
      if (userText) {
        md += `${userText}\n\n`;
      }

    } else if (step.type === 'PLANNER_RESPONSE') {
      let content = step.content || '';

      // Truncate very long model responses (code diffs etc.)
      // but keep enough to show reasoning
      if (content.length > 8000) {
        content = content.substring(0, 8000) + '\n\n*[... response truncated for readability — full output in transcript_full.jsonl ...]*';
      }

      md += `## 🤖 Agent — ${time}\n\n`;
      md += `${content}\n\n`;

      // Show tool calls if present
      if (step.tool_calls && step.tool_calls.length > 0) {
        md += `<details><summary>Tool calls (${step.tool_calls.length})</summary>\n\n`;
        for (const tc of step.tool_calls) {
          const name = tc.name || tc.function?.name || 'unknown';
          md += `- \`${name}\``;
          if (tc.arguments || tc.function?.arguments) {
            const args = tc.arguments || tc.function?.arguments;
            if (typeof args === 'string' && args.length < 200) {
              md += `: ${args}`;
            }
          }
          md += '\n';
        }
        md += `\n</details>\n\n`;
      }
    }

    md += `---\n\n`;
  }

  const outPath = path.join(OUT_DIR, session.file);
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`✓ ${session.file} (${relevant.length} steps)`);
}

console.log(`\nDone — ${SESSIONS.length} session files written to ${OUT_DIR}`);
