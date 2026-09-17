# Architecture

Nexu uses a controller-first local runtime model. In desktop/local mode, a single `apps/controller` process owns Nexu config, compiles OpenClaw config, materializes skills/templates, and orchestrates the OpenClaw runtime.

## System diagram

```
Desktop Shell / Browser
        ↓
Web (React + Radix UI + Tailwind CSS 4 + Vite)
        ↓
Controller (Hono + Zod OpenAPI + lowdb-backed local store)
        ↓
OpenClaw Runtime → Slack / Discord / Feishu API
```

## Tech stack

| Layer                    | Technology                                  |
| ------------------------ | ------------------------------------------- |
| Local control plane      | Hono + @hono/zod-openapi                    |
| Local persistence        | lowdb + JSON config under `~/.nexu/`        |
| Validation               | Zod (single source of truth)                |
| Local auth compatibility | Controller-managed local auth/session shims |
| Frontend                 | React + Radix UI + Tailwind CSS 4 + Vite   |
| Frontend SDK             | @hey-api/openapi-ts (auto-generated)        |
| State                    | React Query (@tanstack/react-query)         |
| Lint/Format              | Biome                                       |
| Package manager          | pnpm workspaces                             |

## Type safety chain

Zod schema is the single source of truth. Types flow one-way, never duplicated:

```
Zod Schema (define once)
  → API route validation (@hono/zod-openapi)
  → OpenAPI spec (auto-generated)
  → Frontend SDK types (@hey-api/openapi-ts)
  → local store/runtime types
```

Never hand-write types that duplicate a schema. Use `z.infer<typeof schema>`.

## Monorepo layout

- **`apps/controller/`** — Single-user controller service. Routes in `src/routes/`, local config store in `src/store/`, OpenClaw runtime integration in `src/runtime/`, compiler logic in `src/lib/openclaw-config-compiler.ts`.
- **`apps/web/`** — React frontend. Pages in `src/pages/`, generated SDK in `lib/api/`, auth client in `src/lib/auth-client.ts`.
- **`apps/desktop/`** — Electron desktop runtime shell and sidecar orchestrator. The active local path launches `controller + web + openclaw` sidecars only.
- **`packages/shared/`** — Shared Zod schemas in `src/schemas/`. Includes bot, channel, gateway, invite, model, skill, and OpenClaw config schemas.
- **`nexu-skills/`** — Public skill repository. Each skill is a directory with `SKILL.md` frontmatter. `skills.json` is the built catalog index.
- **`specs/`** — Design docs, references, product specs, exec plans, generated artifacts.

## Key data flows

**Desktop/local config generation:** Controller reads `~/.nexu/config.json` → compiles OpenClaw config JSON (agents, channels, bindings, models) → writes `OPENCLAW_CONFIG_PATH` and managed skills/templates → OpenClaw hot-reloads.

**Desktop runtime boot:** Electron desktop starts the controller sidecar, waits for controller readiness/auth bootstrap, starts the web sidecar, and delegates OpenClaw process management to `apps/controller`. Release preparation vendors a checksummed platform Computer Use distribution into `runtime/computer-use/` and a checksummed OfficeCLI distribution into `runtime/tools/officecli/`; controller/OpenClaw manifests and launchd plists expose the latter through `OFFICECLI_BIN`. Packaged startup atomically materializes Computer Use under `NEXU_HOME/runtime/computer-use/` so daemons never lock the replaceable `.app` bundle. Third-party runtime payloads retain their required license and notice files.

**Local chat attachments:** The desktop picker stages authorized images, files, and directories under `OPENCLAW_STATE_DIR/media/inbound/`. The controller enforces shared count/size limits, canonical-path and symlink checks, then moves accepted content into the session attachment workspace. Office documents advertise the bundled `officecli` skill to OpenClaw; generated files emitted through `MEDIA:` are mirrored for durable session-history downloads.

**Local automation:** `localAutomation` in the Nexu config defaults both capabilities off. Browser control compiles OpenClaw's extension-backed `chrome` profile so agents operate only user-shared tabs in the real signed-in Chrome. Computer Use compiles one filtered MCP server backed by the signed cua-driver sidecar on macOS 13+ and Windows. The controller serializes bootstrap, setting changes, pairing, permission requests, rollback, and shutdown so a completed disable cannot leave a daemon running. Windows CUA is bound to the controller by parent-liveness stdin, while macOS reports Screen Recording, Accessibility, and Event Synthesizing state and lets the signed CuaDriver process request each permission. Production builds fail closed unless `NEXU_LOCAL_AUTOMATION_PREVIEW_ENABLED=true`; the compiler never grants wildcard command ownership, and `nexu-toolcall-guard` rejects Browser, Computer Use, `exec`, `process`, `nodes`, `gateway`, and `cron` tools outside a desktop local chat session. Both the embedded web proxy and the controller's direct HTTP/WebSocket entry reject non-loopback Host/Origin traffic to prevent credentialed CORS and DNS-rebinding access to the local control plane.

**Proxy policy:** Desktop bootstrap computes one normalized proxy policy from `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY`, applies it to Electron networking, propagates the normalized uppercase env into controller/web/OpenClaw child processes, and always merges loopback bypass entries (`localhost`, `127.0.0.1`, `::1`).

**Channel connection flows:** Frontend calls controller routes → controller validates and stores local credentials/config → controller recompiles OpenClaw config → runtime writers materialize the updated state → OpenClaw reloads.

**Outbound HTTP:** Controller outbound HTTP goes through a shared proxy-aware fetch layer. Local desktop/controller/OpenClaw loopback traffic remains direct; external traffic uses env-derived proxy settings when present.

**Slack events:** Slack messages are handled through the current controller-compiled OpenClaw runtime path rather than a separate Nexu gateway sidecar.

**Feishu events:** Feishu uses a long-lived runtime connection driven by the controller-compiled OpenClaw config.

**Skill catalog:** `tabby.picaso.studio` mirrors the complete ClawHub catalog into Cloudflare D1 every Monday and Thursday, three to four days apart. The controller reads its cursor-based public API for catalog/search/facets and keeps install, update, uninstall, and ledger state local; desktop clients never run a scheduled full-catalog sync. Repo-local skills remain file-based, and the local runtime watches the managed skills directory for hot-reload.

## Persistence

The active local/controller path persists Nexu-owned state under `~/.nexu/` via controller store modules, with `config.json` as the main source of truth and OpenClaw runtime files living under `OPENCLAW_STATE_DIR`.

## Config generator

`apps/controller/src/lib/openclaw-config-compiler.ts` — Active controller-first module that builds OpenClaw config from Nexu local state.

Critical constraints:

- `bindings[].agentId` must match `agents.list[].id`
- `bindings[].match.accountId` must match `channels.{slack|feishu}.accounts` key
- Slack HTTP mode requires `signingSecret`; `groupPolicy` must be `"open"`
- LiteLLM models must set `compat.supportsStore: false`
- Only one agent should have `default: true`

See `specs/references/openclaw-config-schema.md` for full schema and common pitfalls.

## Deeper docs

- `specs/designs/openclaw-multi-tenant.md` — Full system design, data model, phased plan
- `specs/designs/openclaw-architecture-internals.md` — OpenClaw runtime analysis
- `specs/design-specs/core-beliefs.md` — Engineering principles
