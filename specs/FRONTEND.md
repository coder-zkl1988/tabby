# Frontend

## Stack

React 19 + Radix UI + Tailwind CSS 4 + Vite 6. React Router for routing, React Query for server state, better-auth client for sessions.

## API client

Always use the generated SDK from `apps/web/lib/api/`. Never use raw `fetch`.

The SDK is generated from the API's OpenAPI spec:

1. API defines Zod schemas → auto-generates OpenAPI spec
2. `pnpm generate-types` runs `@hey-api/openapi-ts` → generates TypeScript client at `apps/web/lib/api/`
3. Frontend imports from generated `sdk.gen.ts`

After any API route/schema change: `pnpm generate-types` then `pnpm typecheck`.

## Pages

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Welcome | Desktop-first entry point for Cloud sign-in or BYOK setup |
| `/claim` | Slack Claim | Claim a pending Slack workspace invitation |
| `/feishu/bind` | Feishu Bind | Handles Feishu bind result feedback |
| `/workspace` | Home | Workspace dashboard and channel status |
| `/workspace/home` | Home | Workspace dashboard and channel status |
| `/workspace/sessions` | Sessions | Bot conversation sessions |
| `/workspace/sessions/:id` | Sessions | Session detail |
| `/workspace/channels` | Channels | Multi-platform channel management (Slack, Discord, Feishu) |
| `/workspace/channels/slack/callback` | Slack OAuth Callback | Handles Slack redirect |
| `/workspace/integrations` | Integrations | Composio toolkit connections (OAuth) |
| `/workspace/oauth-callback/:integrationId` | OAuth Callback | Handles Composio OAuth redirect |
| `/workspace/rewards` | Rewards | Reward task center for daily, open-source, and social claims |
| `/workspace/settings` | Models / Settings | General profile, model providers, and unified device/automation controls |
| `/workspace/models` | Models / Settings | General profile, model providers, and unified device/automation controls |
| `/workspace/skills` | Skills | Skill catalog |
| `/workspace/skills/:slug` | Skill Detail | Individual skill info and actions |
| `/workspace/automations` | Automations | OpenClaw schedules, delivery rules, run history, and failure visibility |

### Skill Store data flow

- `Explore` uses cursor pagination through the generated SDK. The controller proxies `https://tabby.picaso.studio/api/v1/skill-catalog`, which is the server-side ClawHub mirror.
- `Yours` and install progress use the lightweight local `/api/v1/skillhub/status` endpoint. They do not wait for the remote catalog.
- While a queue item is active, React Query polls local status every three seconds; the full catalog is not re-downloaded for progress updates.
- Catalog identity is `@ownerHandle/slug`. The owner and installed version are persisted in the local ledger so duplicate slugs from different publishers remain distinguishable.
- If the mirror is unavailable, only the first page may fall back to the legacy local cache. A failed remote continuation page is surfaced as an error rather than mixing two catalog revisions.
- `Explore` exposes server-backed download, star, and recently-updated sorting, the full category facet list, catalog freshness, publisher/version metadata, and compact download/star counts. Search results are not filtered again in the browser, so publisher-only matches remain visible.
- A one-click update is shown only when an installed `managed` skill has the exact same owner-scoped identity and the catalog version is newer. The detail page follows the local queue until completion and then refreshes the installed version.
- Active updates cannot be cancelled or uninstalled because the underlying atomic replacement cannot be interrupted safely after the staged directory swap. Legacy ownerless installs remain available under `Yours` but are never attributed to an owner-scoped catalog card.

### KOC startup preparation

KOC setup follows explicit stages: customer inputs → confirmed target profile → generated and reviewed account personas → reviewed eight-field profile materials → phone installation/login and target-account check → application and independent read-only verification → nurturing. The profile card reloads persisted data; generation, editing, and confirmation use revisions so stale cards cannot overwrite newer work. Changing upstream inputs invalidates dependent reviews and phone verification while preserving drafts for correction.

The account planner generates the requested number of personas (default ten), compares actual age/gender/region distribution with the target, and records the operator's review note. Persona archive tags (one or two vertical tags and two or three general tags) are separate from the long-term keyword pools. Similar interests are warnings that operators can review; exact duplicate account names/personas are rejected. New accounts default to ninety posts per day in two segments and at least eleven seconds per post. Existing accounts without a historical daily target retain their previous behavior.

The material card collects nickname, introduction, gender, explicit birthday, region, platform interest tags, avatar, and cover, plus the intended platform account identifier. Generation proposes a birthday derived from the persona age, with the month/day matching the star sign the generated bio states; the operator still confirms it, and a birthday they already entered is never overwritten. Material review alone does not enable nurturing. RunPlanner shows the missing stage and links back to the relevant card; pending/running/history cards and cancellation remain available while new execution is blocked. Application failures and incomplete verification stay visible and cannot be treated as completed setup.

The XHS run planner explains that browsing first checks installation and login. The run progress, result summary, and dashboard detail display the optional `run.preparation` state and its fixed controller reason. Preparation has its own status and does not add to browsing counts or interaction quotas. Human intervention stops the current run and queued work; after completing the required steps on the phone, the operator creates a new run. Historical records without preparation remain readable.

The daily schedule controls keep the label on one line and use a fixed 112px time input. The help text wraps independently and explains that different phones execute concurrently while tasks on the same phone queue.

The account planner loads device ownership across all projects. Device choices show the owning project and account before saving. A conflicting row offers a confirmed transfer that saves the target account and releases the previous binding atomically, retaining the previous account and its history. Unfinished runs and active profile application block transfer. Transferring a row does not start phone work; the normal save action advances the card. Failed ownership loading is visible and retryable, and bound rows cannot be saved until ownership is known.

## Layouts

- **`AuthLayout`** — Requires authenticated session, wraps all workspace routes.
- **`WorkspaceLayout`** — Sidebar + main content area.

### Session workbench

Session detail pages expose browser, canvas, and fixed-sidebar controls beside the conversation header. All three surfaces share the resizable right-side workbench; the fixed-sidebar Pin control remains available when Canvas is closed so pinned cards can be reopened, and each header control reflects the surface currently shown.

The conversation header also exposes a Run center inspector. Its Run tab renders OpenClaw and Nexu Team work as one normalized task DAG with shared lifecycle states, dependency edges, source identity, OpenClaw cancellation, recent tool activity, context-window usage, provider quota/cost data, and generated outputs. Its Approvals tab keeps OpenClaw native execution/plugin approvals separate from Nexu Team workflow approvals, preserves each approval's allowed decisions, and follows the pending queue with a durable reviewer-aware decision history plus metadata-only runtime activity. While the authenticated desktop shell is mounted, a lightweight global watcher polls both approval sources and emits a deduplicated system notification for each newly observed approval when notification permission has been granted; opening Run center is not required. Its Recovery tab exposes delivery failure totals, context-engine quarantine state, and durable compaction snapshots. Only capabilities backed by OpenClaw RPCs are actionable: snapshot restore is available with explicit confirmation, while dead-letter replay/delete and direct quarantine clearing remain diagnostic because OpenClaw does not expose those operations. Its Health tab reports controller/OpenClaw readiness, channel connectivity, model availability, and local automation permissions; failed or unavailable upstreams must remain explicit instead of rendering as an empty or healthy state. Opening Browser or Canvas closes Run center, and opening Run center closes a user-owned workbench, so one right-side surface owns the available width at a time. An agent-owned Browser remains pinned while its task is active and blocks Run center from replacing it.

The workspace conversation rail provides title/group search plus `All`, `Conversations`, `Scheduled`, `Unread`, `Running`, `Needs attention`, and `Archived` filters. Sessions can be pinned, marked read/unread, and assigned an OpenClaw-backed category; pinned sessions sort first and custom categories become visible groups. Running state overlays the controller's live `SessionRunRegistry`, while failed state comes from OpenClaw's persisted run/transcript outcome. `Conversations` excludes scheduled sessions, scheduled classification remains based on the controller-owned `:schedule-` session-key namespace, and filtered scheduled matches stay expanded.

Archived sessions remain hidden by default and can be restored from the dedicated filter. The recovery dialog offers an explicit continue-current action and lists OpenClaw's durable compaction checkpoints. Persisted user messages expose OpenClaw 2026.9.4 native operations: branch forks before that message, while rollback rewinds before it after confirmation. Both restore the selected text and attachments into the composer, and navigate to the returned transcript identity. Assistant messages have no history-mutation controls. Message branching is limited to desktop conversations; native dashboard branch keys do not acquire the host-execution privileges of desktop main/UUID keys. Compaction checkpoints remain available for non-destructive branch creation, and the Run center Recovery tab additionally exposes OpenClaw's real snapshot restore operation with confirmation.

The embedded browser supports up to eight tabs, navigation controls, generated-page auto-open, DOM element selection into the current chat input, and screenshot annotation into an image attachment. Arbitrary pages run in sandboxed Electron `WebContentsView` instances with Node integration disabled; the trusted application webview remains the only surface with the desktop preload bridge. In non-desktop web builds, the browser falls back to a sandboxed iframe without element selection or screenshot capture.

The browser workbench also exposes a control center for the current agent/pairing state and a download center with progress, completed-item reveal, and history clearing. Host failures use an explicit unavailable state with retry. A failed revoke/resume request keeps the last confirmed sharing state and reports the failure instead of optimistically removing the shared tab. Downloads remain scoped to the owning desktop browser surface and never expose their local path to the renderer.

Absolute HTTP(S) links in session Markdown open in the embedded browser. A link request never retargets a tab pinned by an active browser agent; in that case the URL falls back to the system browser. Explicit link navigation also wins over older generated-page artifacts so a stale preview cannot steal focus.

The chat composer attachment menu separates images, files, and directories. Desktop selection copies authorized paths into the app-owned inbound staging directory and sends only staged paths across the local controller boundary; browser-only use falls back to bounded inline base64 attachments. Shared limits cover item count, per-file/image size, inline payload size, and total message size. Session history renders Office and other generated `MEDIA:` files as typed download cards.

The new-conversation composer displays rejected sends and request failures below the input, including the returned error message when available. It preserves the draft and attachments for retry and only navigates to the conversation after the send is accepted.

Both new and existing conversations place the realtime voice microphone immediately before Send inside the shared composer. New conversations bind voice to the selected bot and the same fresh session key used for text; stopping voice opens the saved conversation. Changing bots or leaving the page stops capture. The control appears when the runtime reports a configured voice provider, and an active recording remains stoppable while other composer actions are disabled.

Xiaohongshu editors stay inline in the conversation. The canvas also exposes native Xiaohongshu and phone-preview nodes for AI copy generation, connected images, device selection, and publishing. A publish result with unknown phone status is non-terminal and must not be retried automatically, which avoids duplicate posts.

Generated local pages are discovered from `index.html` / `index.htm` files under the active Bot workspace and served through the controller's constrained preview route. Preview file resolution must remain inside the selected project root after `realpath` resolution, including symlink checks.

The desktop shell exposes Quick Chat from the application menu, resident tray, and `CommandOrControl+Shift+Space`. Every entry snapshots context before bringing Nexu forward: macOS first reads the focused application's accessibility selection, then falls back to the clipboard; Windows and Linux snapshot clipboard text. The composer can also read a Nexu selection and attach a current-display screenshot. Captured context is bounded and staged in memory for one Quick Chat request instead of being persisted as a hidden conversation. The context IPC accepts requests only from the active Deskpet renderer, so other application windows cannot read the staged selection, clipboard fallback, or screenshot.

## Long-running sessions

The session detail composer remains usable while the session is busy, but it
does not submit a second normal turn because concurrent main-session turns can
corrupt OpenClaw's active transcript. Busy messages are classified before send:

- The busy composer exposes `Auto`, `Quick question`, and `Adjust task` modes.
  An explicit mode is authoritative and bypasses intent classification. Quick
  answers render in a separate panel, do not enter the main conversation
  context, and dismiss automatically eight seconds after completion.
- Exact stop requests abort the active run. While the busy composer is empty,
  its single action button stops the run; typing replaces it with the send
  action so stop and send are never shown together.
- The busy composer replaces attachment and Skill controls with a stable
  segmented intent control because BTW/Steer accept text only; the current bot
  and model remain visible as read-only context.
- High-confidence adjustment messages use OpenClaw's `sessions.steer` RPC.
  OpenClaw stops the active run, waits for it to release the session, and then
  starts a replacement run with the updated guidance. This avoids concurrent
  session writers while preserving the existing conversation context.
  In Auto mode, `/btw`, `/side`, `/steer`, and `/tell` remain explicit intent
  selectors and exact stop commands remain local. Other natural-language input
  uses the Controller's isolated model classifier so routing is not tied to a
  Chinese/English keyword list. Low-confidence results ask the user to choose;
  classifier timeout or failure safely falls back to the isolated BTW lane.
- Controller busy state tracks both the interrupted request and its replacement
  until their terminal events arrive. BTW side-run ids remain isolated. The
  frontend timeout fallback only clears local waiting state after the controller
  reports that no main request is active.
- When Steer interrupts a run, Controller history projection removes OpenClaw's
  duplicate gateway abort snapshot and marks the preserved provider output as
  aborted. The frontend keeps that incomplete output inside the activity group
  instead of presenting it as a completed assistant reply.

## Channels

Channel management lives at `/workspace/channels` ([`apps/web/src/pages/channels.tsx`](../apps/web/src/pages/channels.tsx)). Slack, Feishu, and WeChat support multi-instance connections; Discord remains single-instance per workspace.

### Multi-instance Slack / Feishu / WeChat

Slack (`slack`), Feishu (`feishu`), and WeChat (`wechat`) channels can onboard multiple accounts, each independently routed to one bot:

- **Bot required at connect time.** The connect form for Slack / Feishu / WeChat uses [`<BotPicker />`](../apps/web/src/components/channels/bot-picker.tsx) as a required field. Submitting without a selection surfaces the `channels.errors.botRequired` toast. The local controller's Slack OAuth routes are deprecated placeholders, so the channel page exposes only the working manual Slack setup and does not show a non-functional OAuth action.
- **Instance list rendering.** For `slack` / `feishu` / `wechat`, `channels.tsx` renders a list of connected instances plus a "Connect another" action. Other channel types keep the existing single-instance UI.
- **Instance cards.** Each [`<ChannelInstanceCard />`](../apps/web/src/components/channels/channel-instance-card.tsx) shows the account id, status, and a "Routes to bot: X" row with an inline "Change" button. Changing the bound bot calls `PATCH /api/v1/channels/:id` via the [`useUpdateChannelBot`](../apps/web/src/hooks/use-update-channel-bot.ts) hook.
- **Platform badge.** The platform picker shows an "N connected" count for Slack / Feishu / WeChat once at least one instance is connected; other platforms keep the existing check / loader icon behavior.

Out of scope (possible follow-up, plan D): routing different chats under the same channel account to different bots.

### Per-channel delivery capabilities

Slack and Feishu instance cards expose a collapsible [`ChannelCapabilitiesPanel`](../apps/web/src/components/channels/channel-capabilities-panel.tsx). The panel persists through `PATCH /api/v1/channels/{channelId}/capabilities`, refreshes the channel list, and the controller synchronizes the changed account config to OpenClaw.

- **Slack:** thread reply policy (`replyToMode`), live response mode (`streaming.mode`), and native task cards (`streaming.progress.nativeTaskCards`). Native task cards are available only in progress mode.
- **Feishu:** card/text rendering (`renderMode`), streaming card updates (`streaming`), topic-thread replies (`replyInThread`), automatic TTS policy (`tts.auto`), and inbound/outbound media limit (`mediaMaxMb`).
- **Feishu media visibility:** audio, image, file, and video badges describe capabilities already provided by the bundled runtime; they are not cosmetic enable switches.

Historical channel records keep their former behavior: a `null` capability record is normalized to the UI defaults and is only persisted after the user saves it.

Channel-list and live-status request failures remain distinct from an unconfigured channel. The page renders retryable unavailable states and may keep the last successful list/status visible as explicitly stale partial data. Manual Slack setup also requires a valid controller-derived redirect URL before exposing its manifest link; channel-binding lookup failures disable bot selection and connection until a successful retry.

### Per-channel Feishu permissions

Each Feishu channel instance exposes four permissions via the [`FeishuPermissionsPanel`](../apps/web/src/components/channels/feishu-permissions-panel.tsx) collapsible panel on its [`<ChannelInstanceCard />`](../apps/web/src/components/channels/channel-instance-card.tsx):

- `requireMention` — single toggle. When enabled (default), the bot only replies in groups when @-mentioned.
- `dmPolicy` — `open` (default) / `allowlist` / `disabled`. Controls direct messages.
- `groupPolicy` — `open` (default) / `allowlist` / `disabled`. Controls group messages.
- `allowFrom` — Feishu `open_id` list, shown only when either policy is `allowlist`.

Backward compatibility: when `channel.feishuPermissions` is `null` (historical records), the channel binding compiler emits the previously-hardcoded defaults (`requireMention: true`, `dmPolicy: open`, `groupPolicy: open`, `allowFrom: ["*"]`).

Persistence flow: UI → [`useUpdateFeishuPermissions`](../apps/web/src/hooks/use-update-feishu-permissions.ts) → `PATCH /api/v1/channels/{channelId}/feishu-permissions` → store → `openclawSyncService.syncAll()` → OpenClaw `feishu.accounts[<accountId>]` fields.

## Automations

The Automations page exposes schedule, timezone, assigned bot/model, delivery channel, next run, last duration, latest output, and run history. Delivery can notify only when output changes and can emit an alert after a configured consecutive-failure threshold. The controller persists the last observed output cursor/fingerprint and reconciles `cron.runs` both at startup and after OpenClaw WebSocket reconnect, so results completed while the controller was offline are delivered once with a stable idempotency key. List and history failures render unavailable states with retry rather than empty schedules. The create/edit modal independently reports Bot and Channel dependency failures, supports retry, and cannot create an automation until required resources have loaded successfully.

## Model providers

The Models / Settings provider surface loads the model catalog, provider registry, and persisted provider configuration as one required baseline. Failure in any source renders a single retryable unavailable state and prevents saving, so a request failure cannot overwrite existing providers with an empty document. Provider validation must return usable model ids before a provider can be saved. OpenAI OAuth provider and flow-status failures render a retryable unavailable state; start and disconnect failures preserve the last confirmed connection state and surface an error.

Amazon Bedrock validation requires an explicit model or inference-profile id from the selected region, then runs the bundled OpenClaw live probe against an isolated temporary configuration using the AWS SDK credential chain. The temporary runtime loads only the installed `amazon-bedrock` provider extension and accepts success only for the exact requested model. **This provider is currently hidden from the page** (`modelsPageVisible: false` in the shared provider registry): the `bedrock-converse-stream` api is registered by the external `@openclaw/amazon-bedrock-provider` plugin, which openclaw does not bundle and Nexu does not ship, so the probe always comes back `No API provider registered for api: bedrock-converse-stream` with status `unknown`. Since saving requires a probe returning `ok`, the form could never be saved, and `describeBedrockProbeFailure("unknown")` surfaces only "Check credentials, region, model access, and runtime logs" — a missing plugin is **not** distinguished from an AWS credential failure. Re-enable the entry once the plugin actually ships.

## Memory

The Models / Settings page includes the OpenClaw Memory search status and controls. It distinguishes ready, sync-needed, disabled, unavailable, and loading states; the UI must not label stale or unsynchronized memory as ready. Nexu defaults to OpenClaw's local FTS-only mode with the CJK-compatible `trigram` tokenizer, so memory and optional session transcripts remain searchable without a separate embedding credential. FTS readiness requires the local SQLite full-text index to be available; semantic readiness still requires the bundled OpenClaw deep status probe to complete a real bounded embedding request. The status contract exposes only a search mode and sanitized reason code, while paths, provider errors, and secret material remain outside the browser-facing payload. OpenClaw 2026.9.4 owns automatic synchronization on file changes, session start, and search; the UI no longer offers the retired periodic-sync setting.

## Conventions

### Device and automation settings

The models/settings page includes one `LocalAutomationSettingsSection` card for Android device control, Browser control, and Computer Use. It reads the generated `GET /api/v1/runtime-config` contract once, updates Android through `PATCH /api/v1/runtime-config/device-control`, and updates Browser / Computer Use through `PATCH /api/v1/runtime-config/local-automation`. Toggle rows do not expose implementation details such as backend or transport descriptions; runtime status, required permission actions, and security warnings remain visible.

- Browser control exposes the bundled OpenClaw MV3 extension folder and generates a host-local pairing string. It controls only tabs the user places in the OpenClaw tab group.
- Computer Use reports the packaged platform backend and its permission state. macOS 13+ uses cua-driver, shows each missing Screen Recording, Accessibility, or Event Synthesizing permission, triggers the request from the signed CuaDriver process, and opens the matching System Settings pane for manual completion; macOS versions below 13 remain unsupported without blocking the rest of Nexu. Windows uses CUA. Unknown or stopped backends must render as warnings rather than healthy installed state.
- Both capabilities default off. The UI must not imply that a sidecar being present means a system permission has been granted.
- Only Browser and Computer Use are explicitly labeled Preview; Android device control remains outside that boundary in the same card. Stable production builds expose `previewEnabled=false`, reject new enable/pairing/permission operations, and still allow stale enabled values to be switched off. Preview copy must state that structured consequential-action approval is not implemented yet.

- **State:** React Query for all server state. No manual `fetch` + `useState` patterns.
- **Auth:** `apps/web/src/lib/auth-client.ts` for session management.
- **Toasts:** sonner. **Icons:** lucide-react.
- **Styling:** Tailwind CSS 4. No component library.
- **Components:** Reusable UI components in `src/components/ui/` (Radix UI primitives).

## Key files

- `src/main.tsx` — React entry point
- `src/app.tsx` — Router setup
- `src/lib/auth-client.ts` — better-auth client
- `lib/api/` — Auto-generated SDK (do not edit manually)
