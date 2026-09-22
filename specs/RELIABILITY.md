# Reliability

For the desktop controller, a live OpenClaw health endpoint proves only process availability. Upgrade verification must validate the compiled configuration with the installed runtime, confirm configured agents are present, and exercise a local chat through reply and history read-back. OpenClaw 2026.9.4 rejects retired config keys and stores conversations in SQLite; the controller must use gateway session APIs rather than interpreting a missing legacy JSONL index as an empty history. Gateway read failures surface as unavailable so a disconnected runtime cannot silently erase the conversation list.

## Gateway pools

- Each pool runs one OpenClaw Gateway process serving multiple bots (up to `maxBots`, default 50)
- Bot assignment tracked in `gateway_assignments` table
- Pool capacity tracked via `max_bots` / `current_bots` in `gateway_pools`
- Pod IP stored in DB for webhook forwarding
- Pool status lifecycle: `pending` → `active` → gateway processes traffic

## Config hot-reload

- Pool `config_version` incremented on any bot/channel change
- Gateway supports hybrid reload mode (file watch + API trigger)
- Config generated on-demand via `GET /api/internal/pools/{poolId}/config` (requires `GATEWAY_TOKEN`)
- Production: Config Sync Sidecar watches Redis PubSub → pulls new config → writes file → Gateway reloads
- No downtime during reload — existing sessions continue

## Webhook delivery

- Slack events forwarded to Gateway pod at `http://{podIp}:18789/slack/events/{accountId}`
- HMAC-SHA256 signature verification with 5-minute timestamp window
- Timing-safe comparison to prevent timing attacks
- If no pod available (no Gateway running), events are logged but not delivered
- Slack retries events on timeout, so brief pod unavailability is tolerable

## Observability

- Structured logging: pino or console JSON to stdout
- Infrastructure stack: Prometheus + Grafana (metrics), Loki (logs), Tempo (traces), Langfuse (LLM calls), Sentry (errors)
- See `specs/references/infrastructure.md` for connection details and endpoints

## Failure modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Gateway pod crash | Bot messages not delivered | Slack retries; pod auto-restarts via K8s |
| DB unavailable | No config generation, no OAuth | RDS Multi-AZ failover |
| Config generation error | Gateway runs stale config | Version tracking detects drift |
| Invalid credentials | Signature verification fails | Clear error status on `bot_channels` |
