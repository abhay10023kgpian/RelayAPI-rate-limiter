# RelayAPI — Rate Limiter Solution

## What's running

| Service | Container | Host port | Purpose |
|---|---|---|---|
| Nginx LB | `relay-nginx` | **:8080** | Round-robin entry point (use this for all testing) |
| App node 1 | `relay-app1` | :3001 | Direct access for per-node debugging |
| App node 2 | `relay-app2` | :3002 | Direct access for per-node debugging |
| App node 3 | `relay-app3` | :3003 | Direct access for per-node debugging |
| Redis | `relay-redis` | :6379 | Shared sliding-window state |

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- That's it. No Node.js or Redis needed locally.

## Start

```bash
cd solution/
docker compose up --build
```

Wait for all three nodes to log `listening on port 3000` before sending traffic.

## Quick smoke test

```bash
# Should get pong from a node (note X-Served-By header)
curl -i -H "X-Customer-Id: customer-alpha" http://localhost:8080/api/v1/ping

# Check remaining quota in response headers:
#   X-RateLimit-Limit: 100
#   X-RateLimit-Remaining: 99
#   X-RateLimit-Window: 60s
#   X-Served-By: node-1 (or node-2, node-3 — round-robin)
```

## Customers and quotas

Defined in [`app/src/config/customers.json`](app/src/config/customers.json).

| Customer ID | Name | RPM |
|---|---|---|
| `customer-alpha` | Customer Alpha | 100 |
| `customer-beta` | Customer Beta | 100 |
| `northwind` | Northwind Logistics | 300 |

> **Note:** Northwind batch window override is **not yet enabled** in this build.
> That is the second stakeholder slice — to be added next.

## Verify rate limiting manually

```bash
# Fire 101 requests — the 101st should return HTTP 429
for i in $(seq 1 101); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "X-Customer-Id: customer-alpha" \
    http://localhost:8080/api/v1/ping
done
```

## Inspect Redis state directly

```bash
# See the sorted set for a customer
docker exec relay-redis redis-cli ZCARD "rl:customer-alpha"
docker exec relay-redis redis-cli ZRANGE "rl:customer-alpha" 0 -1 WITHSCORES
```

## Stop

```bash
docker compose down
```

## Algorithm

**Sliding window counter** backed by a Redis sorted set.

- Every allowed request is stored as a member with score = arrival timestamp (ms).
- On each request: evict members older than 60 000 ms, count remaining, allow or reject.
- The entire check-and-increment runs in a single **Lua script** — atomic on the Redis server, no TOCTOU race across nodes.
- If Redis is unreachable: **fail closed** (503) — never silently allow traffic above quota.

See [`app/src/middleware/rateLimiter.js`](app/src/middleware/rateLimiter.js) for full implementation.
