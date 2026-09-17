# Security

## Reporting vulnerabilities

**Do not use this file to submit new security issues.** For responsible disclosure (what to send, scope, timelines), see **[`SECURITY.md`](../SECURITY.md)** in the repository root.

The sections below are **implementation and architecture notes** for developers and auditors.

## Credential handling

- Channel credentials (bot tokens, app secrets, signing secrets) live in the `secrets` map of `~/.nexu/config.json`, encrypted at rest with AES-256-GCM (`apps/controller/src/store/secret-box.ts`). The key is a 32-byte random value in `~/.nexu/secret.key`; both files are written `0600`. There is no `ENCRYPTION_KEY` env var — an earlier revision of this document described a multi-tenant design that the desktop-first product never had, and the claim was false for as long as it stood.
- Encryption and decryption happen at the store boundary, so every caller above it still sees plaintext. Values written before this existed are read as plaintext and sealed on their next write; a value that claims to be encrypted and fails authentication throws rather than returning ciphertext, which would otherwise reach a channel as a broken credential and look like an upstream auth failure.
- **What this protects, precisely.** The controller, the agent runtime, and the user all run as the same OS user, so this is *not* what stops an agent from exfiltrating credentials — the runtime guard's read fence is. What it closes is the config being world-readable to other accounts on the machine (it was `0644`), and a copy of `config.json` alone — in a support bundle, a backup, a pasted bug report — carrying usable credentials.
- Credentials decrypted only when needed (config generation, signature verification)
- **Credentials must never appear in logs, error messages, or API responses**

## Slack signature verification

- All incoming Slack events verified via HMAC-SHA256
- Signing secret retrieved from encrypted `channel_credentials`
- 5-minute timestamp window enforced
- Timing-safe comparison (`crypto.timingSafeEqual`)
- Implementation follows the active controller/runtime event handling path

## Authentication

- better-auth with email/password registration
- HTTP-only session cookies
- `authMiddleware` validates session for all `/v1/*` routes
- Configured in the active controller auth stack

## Desktop local control plane

- The controller is a loopback-only control plane. Its global HTTP middleware rejects non-loopback `Host` values, non-loopback browser `Origin` values, and `Sec-Fetch-Site: cross-site` before CORS or route handlers run.
- The controller's direct WebSocket upgrade path applies the same guard before device mirror/control sockets reach `DeviceMirrorProxy`.
- The packaged embedded web server does not reflect request origins or enable credentialed CORS. It applies equivalent checks to proxied HTTP, preflight, and WebSocket requests.
- OpenClaw Control UI accepts only the configured local web origin and explicit loopback gateway origins. Host-header origin fallback remains disabled.
- These checks are required even when the process binds `127.0.0.1`: CORS alone does not stop DNS rebinding, and WebSocket upgrades do not use CORS.
- Local automation lifecycle operations are serialized. A completed disable operation must leave both persisted capability state and its platform daemon disabled, even when permission requests arrive concurrently.
- Browser control drives only the app's own embedded browser view, through Electron's in-process `webContents.debugger`. Nexu never opens a remote-debugging port: that would expose every WebContents in the app — including renderers holding the user's session — to any local process, and a filtering proxy cannot contain it because anything can connect to the port directly.
- Browser commands execute in the main process, which owns the view. Any command that acts on the page — click, type, scroll — first raises the panel and waits for it to host the view, so the user sees the action that is about to happen. This is also a hard requirement rather than a courtesy: synthesized input into a view the panel has not placed is silently dropped.
- Computer Use is constrained by both the compiled MCP include list and a runtime plugin allowlist. Unknown CUA tools fail closed, and any `peekaboo__*` tool (legacy backend or third-party Peekaboo MCP) is not an approved surface and fails closed; Peekaboo's nested `agent` and remote-debugging `browser` tools are not valid substitutes for Nexu's reviewed Computer Use surface.
- OpenClaw runs compile with `tools.exec.security="full"` and `tools.exec.ask="off"`, and that compiled output is identical for every run: host execution is never gated by an approval prompt. The gate is origin, applied by `nexu-toolcall-guard` at `before_tool_call`. `exec`, `process`, and `code_execution` are refused for runs carrying a `channelId` (every channel-originated run has one in OpenClaw 2026.7.1, whatever the session key looks like) and for cron/schedule session keys. Desktop runs and their derived sub-sessions are untouched — the desktop path never sets `channelId`, since `chat.send` carries only `sessionKey`/`message`/`attachments`. Sub-session lineage is deliberately not judged on key shape: it is absent from the tool context, and most bundled skills are shell-driven, so a shape-based rule would break the user's own team, workflow, and media flows.
- `channelId` on the agent hook context is **not** a conversation id. OpenClaw derives it as `messageChannel ?? provider`, so a plain desktop `chat.send` turn arrives labelled `channelId: "webchat"` — `INTERNAL_MESSAGE_CHANNEL`, the desktop's own surface. Reading that as a remote channel refuses host execution to the person sitting at the app, and if the label is also remembered against the session key it revokes it permanently. The guard therefore treats a channel id as remote only when it is neither one of the runtime's internal surface names (`webchat`, `heartbeat`, `cron`, `webhook`, `voice`, `sessions_send`) nor a bare echo of the message provider, which is the derivation's "no conversation ref" fallback. A real inbound Slack turn carries `C123`, never `slack`. Fixtures for this must be built from the runtime's own derivation; a hand-written context cannot see this class of bug.
- The tool context carries neither `trigger` nor lineage, so run provenance is observed on the agent lifecycle hooks (`before_model_resolve` / `before_prompt_build` / `before_agent_start`, registered together because the runtime already marks some of them deprecated) and looked up by `runId` at tool-call time. `session_start` is deliberately not among them: its context has no `runId`. This is what catches the unattended runs no context signal can see: `heartbeat`, `cron`, and `memory` triggers. Mid-run continuations (`budget`, `overflow`, `timeout_recovery`) are excluded on purpose — they resume a turn a human already started, and restricting them would revoke host execution halfway through the desktop user's own work.
- Provenance can only ever restrict. A run the guard never observed — it loaded mid-run, or OpenClaw restarted — falls through to the context-level signals instead of being refused, so the observation gap cannot strand the desktop user without host execution.
- Trigger-based restrictions are scoped to their `runId`, never permanently remembered against the session key. Heartbeat runs on `agent:<bot>:main`, the same key the desktop user types into; a permanent mark there would revoke the user's own host execution from their next turn on. Only intrinsically restricted sessions (a channel conversation) are remembered by key. Propagation to a sub-session joins through the run instead: the guard indexes `sessionKey -> active runId`, so `subagent_spawned` — which reports the requester's session key and not its run id — resolves the requester's actual run and inherits its reason. OpenClaw serializes runs per session, so the index has one entry per session, and it is cleared at `agent_end`.
- An unattended trigger outranks a delivery channel when both are present, so a cron run that also posts to Slack is governed by the `automations` switch rather than the `channels` one.
- The escape hatch is keyed on the bot that owns the *restricted origin*, not the bot the executing run happens to carry. `sessions_spawn` lets a restricted run choose its child's `agentId`, which would otherwise let it borrow a more permissive bot's opt-out.
- Restrictions are released when their session ends (`session_end` / `subagent_ended` / `agent_end`); the map's size bound is only a memory backstop and refreshes live entries on lookup. Plain FIFO eviction was exploitable: a restricted run could flood the map with new sessions until its own entry was dropped, un-restricting itself.
- A restricted origin may only call tools on a reviewed allowlist built from OpenClaw's own builtin groups minus execution, control plane, and lateral movement, plus Nexu's own plugin tools. Anything else — a user-installed MCP server, a third-party plugin — is refused. This is the standing replacement for `plugins.allow`, which PR #17 removed: the compiled config no longer enumerates the tool surface, so an MCP server that shells out would otherwise be arbitrary execution under a different name. `sessions_send` is deliberately absent, because injecting into another session hands attacker text to one that runs at the host tier.
- Restricted origins cannot write the agent's instruction files (`AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `SCHEDULE.md`, `BOOTSTRAP.md`). This is what stops one injected turn from becoming permanent: `workspace-template-writer` is strict seed-if-missing and never overwrites, so a poisoned copy survives every resync, and `HEARTBEAT.md` in particular is read on a timer in the main session with nobody watching. The desktop user is not fenced here — editing your own assistant's instructions is the product working.
- Restricted origins additionally cannot `read` the credential roots (`NEXU_HOME`, `<stateDir>/openclaw.json`, `~/.ssh`, `~/.aws`, `~/Library/Keychains`). Gating execution and persistence without this leaves `read` + `web_fetch` as a shell-free exfiltration path, and `<NEXU_HOME>/config.json` stores channel app secrets in plain text. The desktop tier is not read-fenced: the user asking their own assistant about their own config is the product working.
- OpenClaw reads a plugin's source once, at registration, and the local dev stack starts it *before* the controller materializes plugins. The controller therefore compares the materialized copy against the shipped one and restarts OpenClaw when they differ, so a guard update cannot keep running the previous version of a security control until some unrelated restart happens.
- A scheduled run refused host execution is reported by the guard to `POST /api/internal/runtime/host-execution-blocked`, which records it on the owning schedule (`lastHostExecutionBlock`) so the automations page shows why the work did not happen. Without it the user finds out from a missing artifact: the run completes, the agent explains it could not do the work, and the schedule still looks healthy. The report is fire-and-forget and deduplicated per session and tool — the block itself never depends on the controller being reachable.
- The per-bot escape hatch is `hostExecution.channels` / `hostExecution.automations`, both defaulting to `"restricted"`. It is a setting, never a prompt. The guard reads it from its plugin config, which only the controller writes and which the write fence protects, and it applies only to the reason it was written for — an inherited restriction whose root is unknown stays refused. Because `api.pluginConfig` is captured once at plugin registration, `AgentService.updateBot` restarts OpenClaw when either switch changes; writing `openclaw.json` alone would leave the switch a silent no-op.
- Origin tiering alone would be wrapped around the wrong thing, because `write` reaches the same outcomes without a shell. `write`/`edit`/`apply_patch` are refused **for every tier, desktop included** when the target resolves inside the runtime's own critical paths: `<OPENCLAW_STATE_DIR>/extensions` (the guard's own source), `<OPENCLAW_STATE_DIR>/openclaw.json`, the hot-reloaded skills directories, and `NEXU_HOME`. None of these has a legitimate agent-tool writer; SkillHub installs, plugin materialization, and schedule writes all run in the controller process.
- The agent workspace `<OPENCLAW_STATE_DIR>/agents/<agentId>` is an explicit allow-root that wins over every fence root, and this is load-bearing rather than a convenience: `OPENCLAW_STATE_DIR` is nested *inside* `NEXU_HOME` under `pnpm start` and under the controller's own default, so fencing `NEXU_HOME` as a tree without the carve-out blocks every file the desktop user's own agent writes. Any test fixture for the fence must cover the nested layout; sibling directories cannot see this class of failure.
- Fence candidates are collected by parameter key plus the host's `derivedPaths`, never by scanning values — scanning would fence a write whose content merely mentions a fenced path. Relative candidates are resolved against the run's workspace: `write`/`edit` accept "relative or absolute" and the host derives paths only for `apply_patch`, so an absolute-only fence is a no-op against `../../openclaw.json`. Resolution runs `realpath` on the nearest existing ancestor so a symlinked parent cannot step around the fence, and containment is compared case-insensitively on macOS and Windows, whose default filesystems are case-insensitive.
- Derived sessions are never more trusted than their parent. `forkSession`/`branchSession` mint `agent:<bot>:fork:<uuid>` / `:branch:<uuid>` when the parent is not desktop-shaped, so a channel conversation cannot be forked into the desktop shape that unlocks browser control and the runtime control plane.
- Files served by the local web preview route carry `Content-Security-Policy: connect-src 'none'; form-action 'none'; base-uri 'none'`. They are agent-written and served from the control plane's own origin, so without this a preview page's script is a same-origin caller of the control plane and can start an agent run. A document-level `sandbox` is the wrong tool here: it would put the page in an opaque origin, and its own subresource loads would then be rejected by the loopback guard as cross-site.
- Non-sandbox runs execute on the local gateway, while `SANDBOX_ENABLED=true` routes the same tools to the sandbox. Plugin-owned permission prompts remain governed by the plugin that requested them and are not silently auto-resolved by this setting.
- Heartbeat is enabled for the default agent at OpenClaw's 30-minute default because Nexu never configures `agents.defaults.heartbeat`. It is an unattended run in the desktop-tier main session. Note that `heartbeat: { enabled: false }` does NOT disable it — `isHeartbeatEnabledForAgent` tests the truthiness of the object and never reads `.enabled`, so writing that key would enable heartbeat for *every* agent instead of none. The disabling shape is `every: "off"`, which yields a null interval that the runner skips.
- Quick Chat reads the foreground app's selected text. On macOS this requires the `com.apple.security.automation.apple-events` entitlement and a System Events AppleScript read of `AXSelectedText`, so the first invocation raises the system automation consent prompt described by `NSAppleEventsUsageDescription`. The capture is bounded rather than ambient: only the current selection, truncated to 8,000 characters, held for at most two minutes, cleared once consumed, and never re-read in the background. Declining consent falls back to the clipboard. This is user-visible new host access and must be called out in release notes for any build that ships it, not only in the OS prompt.
- `commands.ownerAllowFrom` must not contain a wildcard. OpenClaw 2026.7.1 reads a wildcard command owner as "every sender is an owner", which exposes the owner-only `nodes`, `gateway`, and `cron` tools to any channel.
- A successful Computer Use tool return proves only that the provider accepted or dispatched an action. Nexu accepts completion evidence only when CUA 0.12.6 returns `verified: true` through trusted structured output, an enriched provider verification matches the invocation's property/expected/element metadata, a typed/assigned value is read back from the same element reference and app/window/snapshot, or a launched target is subsequently observed. Verification-shaped arbitrary text is never trusted. `set_value` evidence requires normalized equality for the complete value field; prefixes, substrings, and similarly named keys such as `default_value` are insufficient. Clearing a field requires an explicit structured empty value or quoted `value=""`/`value=''` evidence from that exact element. Unstructured observation text must identify the element at the line prefix or in an explicit ID field; an ID substring or prefix collision is not evidence. A generic same-target screenshot does not prove that a click, hotkey, scroll, drag, menu, dialog, Dock, or window action achieved its intended result; those actions remain unverified until the provider exposes an action-specific postcondition. Text evidence must come from actual value fields, never labels, titles, or unrelated page text. A failed action remains unresolved unless the exact tool invocation is retried successfully, and every unresolved mutation remains independently pending. Targetless/frontmost mutations remain unverified. Launch results may add provider-returned PID/window aliases so a Windows launch-by-name can be verified through its actual process/window identity.
- Chat `final`, `error`, and `aborted` events are terminal only for their `runId`. The Controller freezes and caches an unverified final decision so every concurrent SSE subscriber receives the same failure, suppresses late/replayed chat events for that run, keeps a session-level SSE connection available to later runs, and continues to permit independent side results. The pending-session UI maintains its own terminal latch for SSE error/aborted events so they cannot be overwritten by a late delta or success notification; session-discovery retries do not consume that SSE terminal state.
- The runtime plugin rewrites unverified terminal assistant messages before transcript persistence, and the Controller independently converts the corresponding desktop SSE `final` event to `local_automation_unverified`. These are complementary integrity checks; prompts and model self-reporting are not completion evidence.

### Internal API — Two-token model

Internal endpoints (`/api/internal/*`) use a two-tier token system:

| Token | Env var | Purpose | Who holds it |
|-------|---------|---------|-------------|
| Internal token | `INTERNAL_API_TOKEN` | Privileged operations (config, secrets mgmt, skill sync) | Controller-managed local runtime only |
| Skill token | `SKILL_API_TOKEN` | Skill-facing operations (fetch scoped secrets, record artifacts) | OpenClaw child process (via env) |

**Middleware:**
- `requireInternalToken(c)` — accepts only `INTERNAL_API_TOKEN`
- `requireSkillToken(c)` — accepts `SKILL_API_TOKEN` or `INTERNAL_API_TOKEN` (superset)
- Both use `crypto.timingSafeEqual` for constant-time comparison
- Implementation follows the active controller internal-auth middleware

**Endpoint mapping:**

| Endpoint | Auth |
|----------|------|
| `GET /config`, `GET /config/latest`, `GET /config/versions/:v` | `requireInternalToken` |
| `POST /register`, `POST /heartbeat` | `requireInternalToken` |
| `PUT /secrets` | `requireInternalToken` |
| `POST /sessions`, `PATCH /sessions/:id`, `POST /sessions/sync-discord` | `requireInternalToken` |
| `GET /secrets/:skillName` | `requireSkillToken` |
| `POST /artifacts`, `PATCH /artifacts/:id` | `requireSkillToken` |
| `POST /composio/execute`, `POST /composio/disconnect` | `requireSkillToken` |

### OpenClaw process isolation

The gateway strips privileged env vars before spawning the OpenClaw child process:
- `INTERNAL_API_TOKEN` — **not inherited** by OpenClaw
- `ENCRYPTION_KEY` — **not inherited** by OpenClaw
- `SKILL_API_TOKEN` — inherited, used by skills to fetch scoped secrets

`nexu-context.json` (written by gateway sidecar) contains only `apiUrl`, `poolId`, and `agents` — no tokens or secrets on disk.

## Pool secrets scoping

- Secrets stored in `pool_secrets` table, encrypted with AES-256-GCM
- Each secret has a `scope` field: `pool` (available to all skills) or `skill:<name>` (specific skill only)
- Skills fetch their secrets at runtime via `GET /api/internal/secrets/:skillName` using `SKILL_API_TOKEN`
- API returns only secrets where `scope = 'pool'` OR `scope = 'skill:<skillName>'`

## Secret management

- Production: AWS Secrets Manager → External Secrets Operator → K8s Secrets
- Local dev: `.env` file (never committed)
- Required: `DATABASE_URL`, `ENCRYPTION_KEY`, `INTERNAL_API_TOKEN`, `SKILL_API_TOKEN`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `BETTER_AUTH_SECRET`
- Optional: `LITELLM_BASE_URL`, `LITELLM_API_KEY`

## OAuth state

- Slack OAuth state tokens stored in `oauth_states` table with expiry
- State verified on callback to prevent CSRF
- Tokens marked as used after consumption (single-use)

## Composio integration OAuth

- Third-party OAuth flows (Gmail, Google Calendar, etc.) managed via Composio SDK
- `user_integrations` table tracks per-user OAuth connection state
- `integration_credentials` stores encrypted credential material (AES-256-GCM)
- OAuth state parameter stored in `user_integrations.oauth_state` for CSRF prevention
- Connection URLs generated server-side (`composio-routes.ts`) — never crafted client-side
- `composio-exec.js` runs in OpenClaw child process with `SKILL_API_TOKEN` only (no `INTERNAL_API_TOKEN`)
- Auth endpoint: `POST /api/internal/composio/execute` requires `requireSkillToken`
- Disconnect endpoint: `POST /api/internal/composio/disconnect` requires `requireSkillToken`

## Review checklist

- [ ] No credentials in log output or error messages
- [ ] New API endpoints behind `authMiddleware`, `requireInternalToken`, or `requireSkillToken`
- [ ] Encrypted storage for any new secret material
- [ ] Slack signature verification for any new webhook endpoint
- [ ] No `ENCRYPTION_KEY` or tokens in committed code
- [ ] New loopback HTTP or WebSocket surfaces reject hostile Host/Origin values and include DNS-rebinding regression coverage
- [ ] Local automation mutations have fresh same-target completion evidence, typed/assigned values are bound to the same stable element ID in that evidence, and host `exec`/`process` cannot bypass the declared capability boundary
