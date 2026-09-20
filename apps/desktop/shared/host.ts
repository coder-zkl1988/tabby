import type {
  DesktopAttachmentPickerKind,
  DesktopStagedAttachment,
} from "@nexu/shared";
import type { DesktopBuildInfo, DesktopRuntimeConfig } from "./runtime-config";
export type { DesktopBuildInfo, DesktopRuntimeConfig } from "./runtime-config";

export const hostInvokeChannels = [
  "app:get-info",
  "diagnostics:get-info",
  "diagnostics:crash-main",
  "diagnostics:crash-renderer",
  "diagnostics:export",
  "diagnostics:upload",
  "env:get-controller-base-url",
  "env:get-runtime-config",
  "runtime:get-state",
  "runtime:start-unit",
  "runtime:stop-unit",
  "runtime:start-all",
  "runtime:stop-all",
  "runtime:show-log-file",
  "runtime:query-events",
  "desktop:get-cloud-status",
  "desktop:create-cloud-profile",
  "desktop:connect-cloud-profile",
  "desktop:disconnect-cloud-profile",
  "desktop:switch-cloud-profile",
  "desktop:import-cloud-profiles",
  "desktop:update-cloud-profile",
  "desktop:delete-cloud-profile",
  "desktop:get-minimax-oauth-status",
  "desktop:start-minimax-oauth",
  "desktop:cancel-minimax-oauth",
  "desktop:get-shell-preferences",
  "desktop:update-shell-preferences",
  "desktop:deskpet-send-message",
  "desktop:deskpet-start-chat",
  "desktop:deskpet-register-current-chat",
  "desktop:deskpet-reply-current-chat",
  "desktop:deskpet-open-current-chat",
  "desktop:deskpet-pause-current-reply",
  "desktop:deskpet-activity",
  "desktop:deskpet-move-window",
  "desktop:deskpet-set-mouse-events",
  "desktop:get-quick-chat-context",
  "desktop:report-error",
  "desktop:get-rewards-status",
  "desktop:set-reward-balance",
  "desktop:rewards-updated",
  "desktop:pick-attachments",
  "desktop:browser-control",
  "shell:open-external",
  "update:check",
  "update:get-capability",
  "update:download",
  "update:install",
  "update:get-current-version",
  "update:get-status",
  "update:set-channel",
  "update:set-source",
  "component:check",
  "component:install",
  "setup:animation-complete",
  "app:quit",
] as const;

export type HostInvokeChannel = (typeof hostInvokeChannels)[number];

export type RuntimeEventQuery = {
  unitId?: RuntimeUnitId;
  actionId?: string;
  reasonCode?: RuntimeReasonCode;
  afterCursor?: number;
  limit?: number;
};

export type RuntimeEventQueryResult = {
  entries: RuntimeLogEntry[];
  nextCursor: number;
};

export type DiagnosticsExportResult = {
  status: "success" | "cancelled" | "failed";
  outputPath?: string;
  warnings?: string[];
  errorMessage?: string;
};

export type DiagnosticsUploadResult = {
  status: "success" | "failed";
  /** Sentry event id — the reference the user reads back to support. */
  referenceId?: string;
  sizeBytes?: number;
  warnings?: string[];
  errorMessage?: string;
};

export type DesktopBrowserViewportMode = "responsive" | "mobile" | "tablet";

export type DesktopBrowserHistoryItem = {
  id: string;
  label: string;
  sublabel: string;
  selected: boolean;
};

export type DesktopBrowserControl =
  | {
      action: "show";
      tabId: string;
      url: string;
      bounds: { x: number; y: number; width: number; height: number };
      zoomFactor?: number;
    }
  | { action: "hide" | "dispose" }
  | {
      action:
        | "center-state"
        | "clear-downloads"
        | "revoke-agent"
        | "resume-agent";
    }
  | { action: "show-download"; downloadId: string }
  | {
      /**
       * A conversation was deleted; drop the agent page it opened. Without
       * this the view outlives the session that created it, and the next
       * conversation to reach that derived tab id inherits its page.
       */
      action: "forget-session";
      sessionKey: string;
    }
  | {
      action: "choose-viewport";
      tabId: string;
      currentMode: DesktopBrowserViewportMode;
      anchor: { x: number; y: number };
    }
  | {
      action: "choose-history";
      tabId: string;
      items: DesktopBrowserHistoryItem[];
      anchor: { x: number; y: number };
    }
  | {
      action: "close-tab" | "state" | "select-element" | "capture";
      tabId: string;
    }
  | { action: "navigate"; tabId: string; url: string }
  | {
      action: "command";
      tabId: string;
      command: "back" | "forward" | "reload" | "stop";
    }
  // Agent-facing actions. `click-ref` and `type-ref` address elements by a ref
  // handed out by `snapshot`, so the agent never has to guess coordinates.
  | {
      action: "snapshot";
      tabId: string;
      maxNodes?: number;
      visibleOnly?: boolean;
    }
  // One element's current state, read without walking the whole tree — the
  // evidence returned after an action.
  | { action: "describe-ref"; tabId: string; ref: string }
  | { action: "click-ref" | "hover-ref"; tabId: string; ref: string }
  | {
      action: "type-ref";
      tabId: string;
      ref: string;
      text: string;
      submit?: boolean;
      append?: boolean;
    }
  | { action: "press-key"; tabId: string; key: string; ref?: string }
  | { action: "select-ref"; tabId: string; ref: string; option: string }
  | { action: "scroll"; tabId: string; deltaY: number }
  // A downscaled JPEG for the model, unlike `capture`, which hands the
  // renderer a full-resolution PNG for annotation.
  | { action: "screenshot"; tabId: string };

export type DesktopBrowserControlResult =
  | { kind: "ok" }
  | { kind: "viewport"; mode: DesktopBrowserViewportMode }
  | { kind: "history"; artifactId: string | null }
  | {
      kind: "center-state";
      agentSharingEnabled: boolean;
      tabs: Array<{
        id: string;
        title: string;
        url: string;
        loading: boolean;
        agentControlled: boolean;
      }>;
      downloads: Array<{
        id: string;
        filename: string;
        url: string;
        state: "progressing" | "completed" | "cancelled" | "interrupted";
        receivedBytes: number;
        totalBytes: number;
        startedAt: number;
        completedAt?: number;
      }>;
    }
  | {
      kind: "state";
      url: string;
      title: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }
  | {
      kind: "selection";
      selection: {
        url: string;
        selector: string;
        tagName: string;
        text: string;
        ariaLabel: string;
      } | null;
    }
  | { kind: "capture"; dataUrl: string }
  | {
      kind: "screenshot";
      mimeType: string;
      base64: string;
      width: number;
      height: number;
    }
  | { kind: "element"; element: DesktopBrowserSnapshotNode | null }
  | {
      kind: "scroll";
      y: number;
      maxY: number;
    }
  | {
      kind: "snapshot";
      url: string;
      title: string;
      truncated: boolean;
      visibleOnly: boolean;
      nodes: DesktopBrowserSnapshotNode[];
    };

export type DesktopBrowserSnapshotNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  depth: number;
};

export type StartupProbeStatus = "ok" | "error";

export type StartupProbePayload = {
  source: "main" | "preload" | "renderer";
  stage: string;
  status: StartupProbeStatus;
  detail?: string | null;
};

export type HostInvokePayloadMap = {
  "app:get-info": undefined;
  "diagnostics:get-info": undefined;
  "diagnostics:crash-main": undefined;
  "diagnostics:crash-renderer": undefined;
  "diagnostics:export": { source: "diagnostics-page" | "help-menu" };
  "diagnostics:upload": undefined;
  "env:get-controller-base-url": undefined;
  "env:get-runtime-config": undefined;
  "runtime:get-state": undefined;
  "runtime:start-unit": {
    id: RuntimeUnitId;
  };
  "runtime:stop-unit": {
    id: RuntimeUnitId;
  };
  "runtime:start-all": undefined;
  "runtime:stop-all": undefined;
  "runtime:show-log-file": {
    id: RuntimeUnitId;
  };
  "runtime:query-events": RuntimeEventQuery;
  "desktop:get-cloud-status": undefined;
  "desktop:create-cloud-profile": {
    profile: {
      name: string;
      cloudUrl: string;
      linkUrl: string;
    };
  };
  "desktop:connect-cloud-profile": {
    name: string;
  };
  "desktop:disconnect-cloud-profile": {
    name: string;
  };
  "desktop:switch-cloud-profile": {
    name: string;
  };
  "desktop:import-cloud-profiles": {
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
    }>;
  };
  "desktop:update-cloud-profile": {
    previousName: string;
    profile: {
      name: string;
      cloudUrl: string;
      linkUrl: string;
    };
  };
  "desktop:delete-cloud-profile": {
    name: string;
  };
  "desktop:get-minimax-oauth-status": undefined;
  "desktop:start-minimax-oauth": {
    region: "global" | "cn";
  };
  "desktop:cancel-minimax-oauth": undefined;
  "desktop:get-shell-preferences": undefined;
  "desktop:update-shell-preferences": {
    launchAtLogin?: boolean;
    showInDock?: boolean;
    deskpetEnabled?: boolean;
    crashReportsEnabled?: boolean;
    sessionReplayEnabled?: boolean;
  };
  "desktop:deskpet-send-message": {
    text: string;
    attachments?: DesktopQuickChatAttachment[];
  };
  "desktop:deskpet-start-chat": {
    text: string;
    attachments?: DesktopQuickChatAttachment[];
  };
  "desktop:deskpet-register-current-chat": {
    botId: string;
    sessionKey: string;
    sessionId?: string;
  };
  "desktop:deskpet-reply-current-chat": {
    text: string;
    attachments?: DesktopQuickChatAttachment[];
  };
  "desktop:deskpet-open-current-chat":
    | {
        intent?: "open" | "reply";
      }
    | undefined;
  "desktop:deskpet-pause-current-reply": undefined;
  "desktop:deskpet-activity": {
    mood: DesktopDeskpetMood;
    durationMs?: number;
    replyText?: string;
  };
  "desktop:deskpet-move-window": {
    deltaX: number;
    deltaY: number;
  };
  "desktop:deskpet-set-mouse-events": {
    ignore: boolean;
    forward?: boolean;
  };
  "desktop:get-quick-chat-context": {
    includeSelectedText: boolean;
    includeScreenshot: boolean;
  };
  "desktop:report-error": {
    area: string;
    reasonCode?: string;
    message: string;
    extra?: Record<string, unknown>;
  };
  "desktop:get-rewards-status": undefined;
  "desktop:set-reward-balance": {
    balance: number;
  };
  "desktop:rewards-updated": undefined;
  "desktop:pick-attachments": {
    kind: DesktopAttachmentPickerKind;
  };
  "desktop:browser-control": DesktopBrowserControl;
  "shell:open-external": {
    url: string;
  };
  "update:check": undefined;
  "update:get-capability": undefined;
  "update:download": undefined;
  "update:install": undefined;
  "update:get-current-version": undefined;
  "update:get-status": undefined;
  "update:set-channel": { channel: UpdateChannelName };
  "update:set-source": { source: UpdateSource };
  "component:check": undefined;
  "component:install": { id: string };
  "setup:animation-complete": undefined;
  "app:quit": { decision: "quit-completely" | "run-in-background" };
};

export type HostInvokeResultMap = {
  "app:get-info": AppInfo;
  "diagnostics:get-info": DiagnosticsInfo;
  "diagnostics:crash-main": undefined;
  "diagnostics:crash-renderer": undefined;
  "diagnostics:export": DiagnosticsExportResult;
  "diagnostics:upload": DiagnosticsUploadResult;
  "env:get-controller-base-url": {
    controllerBaseUrl: string;
  };
  "env:get-runtime-config": DesktopRuntimeConfig;
  "runtime:get-state": RuntimeState;
  "runtime:start-unit": RuntimeState;
  "runtime:stop-unit": RuntimeState;
  "runtime:start-all": RuntimeState;
  "runtime:stop-all": RuntimeState;
  "runtime:show-log-file": {
    ok: boolean;
  };
  "runtime:query-events": RuntimeEventQueryResult;
  "desktop:get-cloud-status": {
    connected: boolean;
    polling?: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    models?: Array<{
      id: string;
      name: string;
      provider?: string;
    }>;
    cloudUrl: string;
    linkUrl: string | null;
    activeProfileName: string;
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
      connected: boolean;
      polling?: boolean;
      userId?: string | null;
      userName?: string | null;
      userEmail?: string | null;
      connectedAt?: string | null;
      modelCount: number;
    }>;
  };
  "desktop:create-cloud-profile": {
    ok: boolean;
    connected: boolean;
    polling?: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    models?: Array<{
      id: string;
      name: string;
      provider?: string;
    }>;
    cloudUrl: string;
    linkUrl: string | null;
    activeProfileName: string;
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
      connected: boolean;
      polling?: boolean;
      userId?: string | null;
      userName?: string | null;
      userEmail?: string | null;
      connectedAt?: string | null;
      modelCount: number;
    }>;
    configPushed: boolean;
  };
  "desktop:connect-cloud-profile": {
    browserUrl?: string;
    error?: string;
    status: HostInvokeResultMap["desktop:get-cloud-status"];
    configPushed: boolean;
  };
  "desktop:disconnect-cloud-profile": {
    ok: boolean;
    connected: boolean;
    polling?: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    models?: Array<{
      id: string;
      name: string;
      provider?: string;
    }>;
    cloudUrl: string;
    linkUrl: string | null;
    activeProfileName: string;
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
      connected: boolean;
      polling?: boolean;
      userId?: string | null;
      userName?: string | null;
      userEmail?: string | null;
      connectedAt?: string | null;
      modelCount: number;
    }>;
    configPushed: boolean;
  };
  "desktop:switch-cloud-profile": {
    ok: boolean;
    connected: boolean;
    polling?: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    models?: Array<{
      id: string;
      name: string;
      provider?: string;
    }>;
    cloudUrl: string;
    linkUrl: string | null;
    activeProfileName: string;
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
      connected: boolean;
      polling?: boolean;
      userId?: string | null;
      userName?: string | null;
      userEmail?: string | null;
      connectedAt?: string | null;
      modelCount: number;
    }>;
    configPushed: boolean;
  };
  "desktop:import-cloud-profiles": {
    ok: boolean;
    connected: boolean;
    polling?: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    models?: Array<{
      id: string;
      name: string;
      provider?: string;
    }>;
    cloudUrl: string;
    linkUrl: string | null;
    activeProfileName: string;
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
      connected: boolean;
      polling?: boolean;
      userId?: string | null;
      userName?: string | null;
      userEmail?: string | null;
      connectedAt?: string | null;
      modelCount: number;
    }>;
    configPushed: boolean;
  };
  "desktop:update-cloud-profile": {
    ok: boolean;
    connected: boolean;
    polling?: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    models?: Array<{
      id: string;
      name: string;
      provider?: string;
    }>;
    cloudUrl: string;
    linkUrl: string | null;
    activeProfileName: string;
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
      connected: boolean;
      polling?: boolean;
      userId?: string | null;
      userName?: string | null;
      userEmail?: string | null;
      connectedAt?: string | null;
      modelCount: number;
    }>;
    configPushed: boolean;
  };
  "desktop:delete-cloud-profile": {
    ok: boolean;
    connected: boolean;
    polling?: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    models?: Array<{
      id: string;
      name: string;
      provider?: string;
    }>;
    cloudUrl: string;
    linkUrl: string | null;
    activeProfileName: string;
    profiles: Array<{
      name: string;
      cloudUrl: string;
      linkUrl: string;
      connected: boolean;
      polling?: boolean;
      userId?: string | null;
      userName?: string | null;
      userEmail?: string | null;
      connectedAt?: string | null;
      modelCount: number;
    }>;
    configPushed: boolean;
  };
  "desktop:get-minimax-oauth-status": {
    connected: boolean;
    inProgress: boolean;
    region?: "global" | "cn" | null;
    error?: string | null;
  };
  "desktop:start-minimax-oauth": {
    connected: boolean;
    inProgress: boolean;
    region?: "global" | "cn" | null;
    error?: string | null;
    browserUrl?: string;
    started: boolean;
  };
  "desktop:cancel-minimax-oauth": {
    connected: boolean;
    inProgress: boolean;
    region?: "global" | "cn" | null;
    error?: string | null;
    cancelled: boolean;
  };
  "desktop:get-shell-preferences": {
    launchAtLogin: boolean;
    showInDock: boolean;
    deskpetEnabled: boolean;
    supportsLaunchAtLogin: boolean;
    supportsShowInDock: boolean;
    crashReportsEnabled: boolean;
    sessionReplayEnabled: boolean;
  };
  "desktop:update-shell-preferences": {
    launchAtLogin: boolean;
    showInDock: boolean;
    deskpetEnabled: boolean;
    supportsLaunchAtLogin: boolean;
    supportsShowInDock: boolean;
    crashReportsEnabled: boolean;
    sessionReplayEnabled: boolean;
  };
  "desktop:deskpet-send-message": {
    ok: true;
    mode: "started" | "replied";
    path: string;
  };
  "desktop:deskpet-start-chat": {
    ok: true;
    path: string;
  };
  "desktop:deskpet-register-current-chat": {
    ok: true;
  };
  "desktop:deskpet-reply-current-chat": {
    ok: true;
  };
  "desktop:deskpet-open-current-chat": {
    ok: boolean;
    path?: string;
  };
  "desktop:deskpet-pause-current-reply": {
    ok: boolean;
  };
  "desktop:deskpet-activity": {
    ok: true;
  };
  "desktop:deskpet-move-window": {
    ok: boolean;
  };
  "desktop:deskpet-set-mouse-events": {
    ok: boolean;
  };
  "desktop:get-quick-chat-context": {
    selectedText: string | null;
    selectedTextSource: "selection" | "clipboard" | null;
    screenshot: DesktopQuickChatAttachment | null;
  };
  "desktop:report-error": { reported: boolean };
  "desktop:get-rewards-status": {
    cloudBalance?: {
      totalBalance?: number | null;
    } | null;
  };
  "desktop:set-reward-balance": {
    cloudBalance?: {
      totalBalance?: number | null;
    } | null;
  };
  "desktop:rewards-updated": {
    ok: boolean;
  };
  "desktop:pick-attachments": {
    attachments: DesktopStagedAttachment[];
  };
  "desktop:browser-control": DesktopBrowserControlResult;
  "shell:open-external": {
    ok: boolean;
  };
  "update:check": { updateAvailable: boolean };
  "update:get-capability": DesktopUpdateCapability;
  "update:download": { ok: boolean };
  "update:install": undefined;
  "update:get-current-version": { version: string };
  "update:get-status": {
    phase: "idle" | "downloading" | "ready";
    version: string | null;
  };
  "update:set-channel": { ok: boolean };
  "update:set-source": { ok: boolean };
  "component:check": {
    updates: Array<{
      id: string;
      currentVersion: string | null;
      newVersion: string;
      size: number;
    }>;
  };
  "component:install": { ok: boolean };
  "setup:animation-complete": undefined;
  "app:quit": undefined;
};

export type AppInfo = {
  appName: string;
  appVersion: string;
  platform: NodeJS.Platform;
  isDev: boolean;
};

export type DiagnosticsInfo = {
  crashDumpsPath: string;
  processType: string;
  sentryMainEnabled: boolean;
  sentryDsn: string | null;
  nativeCrashPipeline: "local-only" | "sentry";
  proxy: {
    source: "env" | "system" | "direct";
    httpProxyRedacted: string | null;
    httpsProxyRedacted: string | null;
    allProxyRedacted: string | null;
    noProxy: string[];
  };
};

export type DesktopDevDiagnosticsLogLevel =
  | "debug"
  | "info"
  | "warning"
  | "error";

export type DesktopDevRendererLogEntry = {
  id: string;
  ts: string;
  source: "console" | "page-error";
  level: DesktopDevDiagnosticsLogLevel;
  message: string;
  url: string | null;
  sourceId: string | null;
  line: number | null;
};

export type DesktopDevRendererLogSnapshot = {
  entries: DesktopDevRendererLogEntry[];
  truncated: boolean;
};

export type DesktopDevScreenshotResult = {
  mimeType: "image/png";
  base64: string;
  width: number;
  height: number;
  scaleFactor: number;
};

export type DesktopDevEvalSerializableValue =
  | null
  | boolean
  | number
  | string
  | DesktopDevEvalSerializableValue[]
  | { [key: string]: DesktopDevEvalSerializableValue };

export type DesktopDevEvalResult = {
  ok: boolean;
  valueType: string;
  value: DesktopDevEvalSerializableValue;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

export type DesktopDevDomSnapshotResult = {
  title: string;
  url: string;
  readyState: string;
  htmlLength: number;
  htmlSummary: string;
};

export type DesktopSurface =
  | "web"
  | "openclaw"
  | "control"
  | "cloud-profile"
  | "diagnostics";

export type DesktopChromeMode = "full" | "immersive";

export type DesktopDeskpetMood =
  | "belly-rub"
  | "connection"
  | "error"
  | "idle"
  | "lobster-replying"
  | "peek"
  | "rest"
  | "success"
  | "tease-lobster"
  | "working"
  | "yawn";

export type DesktopDeskpetSize = "small" | "medium" | "large";

export type DesktopDeskpetMoodSource = "auto" | "manual" | "runtime";

export type DesktopQuickChatAttachment = {
  type: "image";
  content: string;
  metadata: {
    mimeType: "image/png";
    filename: string;
    size: number;
  };
};

export type HostDesktopCommand =
  | {
      /**
       * The agent opened a page in the browser view it drives. The panel is
       * what makes that visible, so it raises itself and adopts the agent tab.
       */
      type: "browser:agent-opened";
      tabId: string;
      url: string;
      /**
       * The conversation that drove it. The panel adopts the tab only when
       * this matches the session it is showing, so one conversation's page
       * cannot surface in another.
       */
      sessionKey: string;
    }
  | {
      /**
       * The run that drove the browser ended. The panel stays open but drops
       * its agent pin, so routing closes it again like any other workbench.
       */
      type: "browser:agent-run-ended";
      sessionKey: string;
    }
  | {
      type: "develop:focus-surface";
      surface: Exclude<DesktopSurface, "control">;
      chromeMode: DesktopChromeMode;
    }
  | {
      type: "develop:show-shell";
      surface: DesktopSurface;
      chromeMode: DesktopChromeMode;
    }
  | {
      type: "desktop:check-for-updates";
    }
  | {
      type: "develop:open-set-balance";
    }
  | {
      type: "desktop:rewards-updated";
    }
  | {
      type: "desktop:open-web-path";
      path: string;
      focusReply?: boolean;
    }
  | {
      type: "deskpet:current-chat-replied";
      sessionKey: string;
      text: string;
      sessionId?: string;
    }
  | {
      type: "deskpet:pause-current-reply";
      sessionKey: string;
      sessionId?: string;
    }
  | {
      type: "deskpet:chat-started";
      botId: string;
      sessionKey: string;
      sessionId?: string;
      runId?: string | null;
      text?: string;
      startedAt?: number;
    }
  | {
      type: "setup:progress";
      stage: string;
      detail?: string;
    }
  | {
      type: "setup:complete";
    }
  | {
      type: "deskpet:set-mood";
      mood: DesktopDeskpetMood;
      source?: DesktopDeskpetMoodSource;
      durationMs?: number;
      replyText?: string;
    }
  | {
      type: "deskpet:set-size";
      size: DesktopDeskpetSize;
    }
  | {
      type: "deskpet:open-composer";
    }
  | {
      type: "desktop:shell-preferences-updated";
    };

export type RuntimeUnitSnapshot = Omit<RuntimeUnitState, "logTail">;

export type RuntimeEvent =
  | {
      type: "runtime:unit-state";
      unit: RuntimeUnitSnapshot;
    }
  | {
      type: "runtime:unit-log";
      unitId: RuntimeUnitId;
      entry: RuntimeLogEntry;
    };

export type RuntimeUnitId = "web" | "control-plane" | "controller" | "openclaw";

export type RuntimeUnitKind = "surface" | "service" | "runtime";

export type RuntimeUnitLaunchStrategy =
  | "embedded"
  | "managed"
  | "delegated"
  | "launchd"
  | "external";

export type RuntimeUnitPhase =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type RuntimeLogStream = "stdout" | "stderr" | "system";

export type RuntimeLogKind = "app" | "lifecycle" | "probe";

export type RuntimeReasonCode =
  | "embedded_unit"
  | "start_requested"
  | "start_succeeded"
  | "port_ready"
  | "start_failed"
  | "stop_requested"
  | "managed_error"
  | "process_exited"
  | "delegated_process_detected"
  | "delegated_process_missing"
  | "stdout_line"
  | "stderr_line"
  | "auto_restart_scheduled"
  | "max_restarts_exceeded"
  | "exit_config_error"
  | "launchd_running"
  | "launchd_stopped"
  | "launchd_start_requested"
  | "launchd_stop_requested"
  | "launchd_log_line"
  | "external_available"
  | "external_unavailable";

export type RuntimeLogEntry = {
  id: string;
  cursor: number;
  ts: string;
  unitId: RuntimeUnitId;
  stream: RuntimeLogStream;
  kind: RuntimeLogKind;
  actionId: string | null;
  reasonCode: RuntimeReasonCode;
  message: string;
};

export type RuntimeUnitState = {
  id: RuntimeUnitId;
  label: string;
  kind: RuntimeUnitKind;
  launchStrategy: RuntimeUnitLaunchStrategy;
  phase: RuntimeUnitPhase;
  autoStart: boolean;
  pid: number | null;
  port: number | null;
  startedAt: string | null;
  exitedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  lastReasonCode: RuntimeReasonCode | null;
  lastProbeAt: string | null;
  restartCount: number;
  commandSummary: string | null;
  binaryPath: string | null;
  logFilePath: string | null;
  logTail: RuntimeLogEntry[];
};

export type RuntimeState = {
  startedAt: string;
  units: RuntimeUnitState[];
};

export type HostBridge = {
  bootstrap: HostBootstrap;
  invoke<TChannel extends HostInvokeChannel>(
    channel: TChannel,
    payload: HostInvokePayloadMap[TChannel],
  ): Promise<HostInvokeResultMap[TChannel]>;
  reportStartupProbe(payload: StartupProbePayload): void;
  reportRendererDiagnosticsLog(
    payload: Omit<DesktopDevRendererLogEntry, "id" | "ts" | "source"> & {
      source: "page-error";
    },
  ): void;
  onDesktopCommand(listener: (command: HostDesktopCommand) => void): () => void;
  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
};

export type HostBootstrap = {
  buildInfo: DesktopBuildInfo;
  sentryDsn: string | null;
  posthogApiKey: string | null;
  posthogHost: string | null;
  isPackaged: boolean;
  needsSetupAnimation: boolean;
  webviewPreloadUrl: string;
  devImmersive: boolean;
};

export type UpdateSource = "r2" | "github";
export type UpdateChannelName = "stable" | "beta" | "nightly";

export type UpdateDownloadMode = "none" | "in-app" | "external";

export type UpdateApplyMode =
  | "none"
  | "in-app"
  | "external-installer"
  | "redirect";

export type DesktopUpdateCapability = {
  platform: NodeJS.Platform;
  check: boolean;
  downloadMode: UpdateDownloadMode;
  applyMode: UpdateApplyMode;
  applyLabel: string | null;
  notes: string | null;
};

export const updaterEvents = [
  "update:checking",
  "update:available",
  "update:up-to-date",
  "update:progress",
  "update:downloaded",
  "update:error",
] as const;

export type UpdaterEvent = (typeof updaterEvents)[number];

export interface UpdateCheckDiagnostic {
  channel: UpdateChannelName;
  source: UpdateSource;
  feedUrl: string;
  currentVersion: string;
  remoteVersion?: string;
  remoteReleaseDate?: string;
}

export type UpdaterEventMap = {
  "update:checking": UpdateCheckDiagnostic;
  "update:available": {
    version: string;
    releaseNotes?: string;
    actionUrl?: string;
    diagnostic: UpdateCheckDiagnostic;
  };
  "update:up-to-date": {
    diagnostic: UpdateCheckDiagnostic;
  };
  "update:progress": {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  };
  "update:downloaded": { version: string };
  "update:error": {
    message: string;
    rawMessage?: string;
    diagnostic?: UpdateCheckDiagnostic;
  };
};

export type UpdaterBridge = {
  onEvent<TEvent extends UpdaterEvent>(
    event: TEvent,
    callback: (data: UpdaterEventMap[TEvent]) => void,
  ): () => void;
};
