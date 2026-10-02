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
// ---------------------------------------------------------------------------
/**
 * Returns the effective RPM limit for a customer at the current moment.
 * If the customer has a batch_window and the current UTC time falls within
 * it, returns the elevated RPM. Otherwise returns the contracted RPM.
 *
 * @param {Object} customer - customer config object from customers.json
 * @returns {{ limit: number, inBatchWindow: boolean }}
 */
function resolveLimit(customer) {
  if (!customer.batch_window) {
    return { limit: customer.rpm, inBatchWindow: false };
  }

  const bw = customer.batch_window;
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Parse "HH:MM" → total minutes since midnight
  const [startH, startM] = bw.start_utc.split(':').map(Number);
  const [endH, endM]     = bw.end_utc.split(':').map(Number);
  const startMinutes     = startH * 60 + startM;
  const endMinutes       = endH * 60 + endM;

  let inWindow;
  if (startMinutes <= endMinutes) {
    // Normal range: e.g. 02:00–04:00
    inWindow = currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Wraps midnight: e.g. 23:00–02:00
    inWindow = currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  return {
    limit:         inWindow ? bw.rpm : customer.rpm,
    inBatchWindow: inWindow,
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

    // ── Resolve effective limit (contracted RPM vs batch window RPM) ─────
    const { limit, inBatchWindow } = resolveLimit(customer);
    const key = `rl:${customerId}`;  // one sorted set per customer
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
    res.set('X-Served-By',              process.env.NODE_ID || 'unknown');

    // Flag batch window status so harness and logs can see the active mode
    if (inBatchWindow) {
      res.set('X-RateLimit-Mode', 'batch-window');
    }

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
      in_batch_window: inBatchWindow,
      retry_after_sec: retryAfterSec,
      timestamp:      new Date(now).toISOString(),
      node:           process.env.NODE_ID || 'unknown',
    };

    if (inBatchWindow) {
      // Overage during batch window — this is the data Marcus/Sales need
      // to prove Northwind's real demand exceeds even the elevated ceiling
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
      in_batch_window: inBatchWindow,
    });
  };
}

module.exports = { createRateLimiter };
