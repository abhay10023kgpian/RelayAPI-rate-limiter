/**
 * Sliding Window Rate Limiter — Redis-backed, atomic via Lua script.
 *
 * Algorithm: sliding window counter over a 60-second lookback using a Redis
 * sorted set. Each accepted request is stored as a member with its arrival
 * timestamp (ms) as the score. On every call we:
 *   1. Remove all members older than (now - 60 000 ms)
 *   2. Count remaining members
 *   3. If count < limit → ZADD the new request, return allowed
 *      If count >= limit → return rejected + oldest member score for Retry-After
 *
 * The entire check-and-increment runs inside a single Lua script so it is
 * atomic on the Redis server — no TOCTOU race across nodes.
 *
 * Batch window support:
 *   If a customer has a `batch_window` in config, and the current UTC time
 *   falls within that window, the elevated RPM is used instead of the
 *   contracted RPM. The middleware has no knowledge of *which* customer
 *   this is — any customer with a batch_window config gets the same logic.
 *   Requests above even the elevated limit still get 429 + Retry-After.
 *
 * Overage logging:
 *   When a request is rejected during a batch window, the overage event is
 *   logged with structured fields so it can be aggregated for contract
 *   renewal documentation (peak RPM, rejection count, time).
 *
 * Error direction (per CTO memo): if Redis is unreachable, fail CLOSED
 * (reject the request) rather than silently allowing traffic.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Customer config
// ---------------------------------------------------------------------------
const CUSTOMERS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config/customers.json'), 'utf8')
);

// Window length in milliseconds
const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Batch window check — pure config-driven, no customer-specific code paths
//
// Three regimes:
//   1. BATCH WINDOW  (02:00–04:00)  → elevated RPM, key = rl:<id>:batch
//   2. GRACE PERIOD  (04:00–04:05)  → linear ramp from elevated → contracted
//                                      same key as batch (rl:<id>:batch) so
//                                      the sliding window memory is continuous
//   3. NORMAL        (all other)    → contracted RPM, key = rl:<id>
//
// Why separate keys:
//   At the end of the grace period, the batch key may still hold entries from
//   elevated-rate traffic. If we used the same key for normal, the count would
//   exceed the contracted limit and trigger a 429 cliff. By switching to a
//   fresh key (rl:<id>), the normal regime starts with count = 0. The batch
//   key expires naturally via Redis TTL.
//
// Why the grace period shares the batch key:
//   The ramp-down limit decreases linearly from 1500 → 300 over grace_minutes.
//   The sliding window still holds entries from the batch window — these entries
//   age out naturally (60s TTL). Sharing the key means the ramp-down accounts
//   for recent batch traffic correctly instead of starting fresh at 1500.
// ---------------------------------------------------------------------------
/**
 * Returns the effective RPM limit and Redis key for a customer right now.
 *
 * @param {Object} customer   - customer config from customers.json
 * @param {string} customerId - the customer's ID (for key generation)
 * @returns {{ limit: number, key: string, mode: string }}
 *   mode is one of: 'normal', 'batch-window', 'grace-period'
 */
function resolveLimit(customer, customerId) {
  if (!customer.batch_window) {
    return { limit: customer.rpm, key: `rl:${customerId}`, mode: 'normal' };
  }

  const bw           = customer.batch_window;
  const graceMinutes = bw.grace_minutes ?? 5;   // default 5-min grace
  const now          = new Date();
  const currentMins  = now.getUTCHours() * 60 + now.getUTCMinutes()
                     + now.getUTCSeconds() / 60;  // fractional minutes for smooth ramp

  // Parse "HH:MM" → total minutes since midnight
  const [startH, startM] = bw.start_utc.split(':').map(Number);
  const [endH, endM]     = bw.end_utc.split(':').map(Number);
  const startMins        = startH * 60 + startM;
  const endMins          = endH * 60 + endM;
  const graceEndMins     = endMins + graceMinutes;

  // ── Check batch window ──────────────────────────────────────────────────
  let inBatchWindow;
  if (startMins <= endMins) {
    inBatchWindow = currentMins >= startMins && currentMins < endMins;
  } else {
    inBatchWindow = currentMins >= startMins || currentMins < endMins;
  }

  if (inBatchWindow) {
    return {
      limit: bw.rpm,
      key:   `rl:${customerId}:batch`,
      mode:  'batch-window',
    };
  }

  // ── Check grace period (endMins → endMins + graceMinutes) ───────────────
  let inGracePeriod;
  if (graceEndMins <= 1440) {
    // Grace doesn't wrap midnight
    inGracePeriod = currentMins >= endMins && currentMins < graceEndMins;
  } else {
    // Grace wraps midnight (e.g. batch ends 23:58, grace until 00:03)
    inGracePeriod = currentMins >= endMins || currentMins < (graceEndMins - 1440);
  }

  if (inGracePeriod) {
    // Linear ramp: progress 0.0 (just ended) → 1.0 (grace over)
    let minutesIntoGrace;
    if (currentMins >= endMins) {
      minutesIntoGrace = currentMins - endMins;
    } else {
      // Wrapped midnight
      minutesIntoGrace = (1440 - endMins) + currentMins;
    }
    const progress   = Math.min(minutesIntoGrace / graceMinutes, 1.0);
    const rampedLimit = Math.round(bw.rpm - (bw.rpm - customer.rpm) * progress);

    return {
      limit: rampedLimit,
      key:   `rl:${customerId}:batch`,   // shares batch key — sliding window is continuous
      mode:  'grace-period',
    };
  }

  // ── Normal — outside batch and grace ────────────────────────────────────
  return {
    limit: customer.rpm,
    key:   `rl:${customerId}`,            // fresh key — no cliff from batch entries
    mode:  'normal',
  };
}

// ---------------------------------------------------------------------------
// Lua script — evaluated atomically on the Redis server
// Returns an array:
//   [1, newCount]                   → request allowed
//   [0, currentCount, retryAfterSec] → request rejected
// ---------------------------------------------------------------------------
const SLIDING_WINDOW_LUA = `
local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local window_ms  = tonumber(ARGV[2])
local limit      = tonumber(ARGV[3])

-- 1. Evict expired entries
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)

-- 2. Count in-window requests
local count = redis.call('ZCARD', key)

if count < limit then
  -- 3a. Allow — store with a unique member to handle same-millisecond bursts
  local member = tostring(now) .. ':' .. tostring(math.random(1, 999999))
  redis.call('ZADD', key, now, member)
  -- TTL slightly longer than window so Redis GCs the key automatically
  redis.call('PEXPIRE', key, window_ms + 5000)
  return {1, count + 1}
else
  -- 3b. Reject — find oldest entry to compute Retry-After
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_ms = window_ms  -- safe default
  if oldest[2] then
    retry_ms = (tonumber(oldest[2]) + window_ms) - now
    if retry_ms < 0 then retry_ms = 0 end
  end
  -- ceil to next full second
  local retry_sec = math.ceil(retry_ms / 1000)
  return {0, count, retry_sec}
end
`;

// ---------------------------------------------------------------------------
// Middleware factory — call with an ioredis client instance
// ---------------------------------------------------------------------------
function createRateLimiter(redis) {
  return async function rateLimiter(req, res, next) {
    const customerId = req.headers['x-customer-id'];

    // ── Unknown customer → reject immediately, do not consume quota ──────
    if (!customerId) {
      return res.status(400).json({
        error: 'Missing X-Customer-Id header',
      });
    }

    const customer = CUSTOMERS[customerId];
    if (!customer) {
      return res.status(401).json({
        error: `Unknown customer: ${customerId}`,
      });
    }

    // ── Resolve effective limit, Redis key, and mode ─────────────────────
    const { limit, key, mode } = resolveLimit(customer, customerId);
    const now = Date.now();

    let result;
    try {
      result = await redis.eval(
        SLIDING_WINDOW_LUA,
        1,          // number of KEYS
        key,        // KEYS[1]
        now,        // ARGV[1]
        WINDOW_MS,  // ARGV[2]
        limit       // ARGV[3]
      );
    } catch (err) {
      // Redis unavailable — fail CLOSED per CTO directive
      console.error(`[rate-limiter] Redis error for ${customerId}:`, err.message);
      return res.status(503).json({
        error: 'Rate limiter unavailable — request rejected (fail-safe)',
      });
    }

    const allowed      = result[0] === 1;
    const currentCount = result[1];

    // Attach observability headers on every response
    res.set('X-RateLimit-Limit',         limit);
    res.set('X-RateLimit-Remaining',     Math.max(0, limit - currentCount));
    res.set('X-RateLimit-Window',        '60s');
    res.set('X-RateLimit-Contracted',    customer.rpm);
    res.set('X-RateLimit-Mode',          mode);
    res.set('X-Served-By',              process.env.NODE_ID || 'unknown');

    if (allowed) {
      return next();
    }

    // ── Rejected ──────────────────────────────────────────────────────────
    const retryAfterSec = result[2] ?? 1;
    res.set('Retry-After', retryAfterSec);

    // ── Overage logging — structured for contract documentation ──────────
    // These logs can be aggregated to show: "Northwind exceeded even the
    // elevated 1500 RPM batch ceiling N times, peak observed was X RPM."
    // This data feeds the contract renewal conversation.
    const logEntry = {
      event:          'rate_limit_exceeded',
      customer_id:    customerId,
      customer_name:  customer.name,
      effective_limit: limit,
      contracted_rpm: customer.rpm,
      current_count:  currentCount,
      mode,
      retry_after_sec: retryAfterSec,
      timestamp:      new Date(now).toISOString(),
      node:           process.env.NODE_ID || 'unknown',
    };

    if (mode === 'batch-window' || mode === 'grace-period') {
      // Overage during batch/grace — data Marcus/Sales need for renewal
      console.warn(`[overage]`, JSON.stringify(logEntry));
    } else {
      console.log(`[rate-limit]`, JSON.stringify(logEntry));
    }

    return res.status(429).json({
      error:           'Too Many Requests',
      customer_id:     customerId,
      limit,
      contracted_rpm:  customer.rpm,
      window:          '60s',
      retry_after:     `${retryAfterSec}s`,
      mode,
    });
  };
}

module.exports = { createRateLimiter };

