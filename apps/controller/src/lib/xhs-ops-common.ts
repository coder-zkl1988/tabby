import type {
  XhsOpsTakeoverParamConflictCode,
  XhsOpsTakeoverPlanIssue,
} from "@nexu/shared";

/** Client-facing failure; routes map status straight to the HTTP code. */
export class XhsOpsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "XhsOpsError";
  }
}

/**
 * The 409 of a takeover account's interaction / browseDefaults past a limit
 * (§2.5, §6.3): the account routes add `code` and `issues` to the body
 * (xhsOpsAccountConflictResponseSchema); everywhere else it is a plain 409.
 */
export class XhsOpsTakeoverParamError extends XhsOpsError {
  constructor(
    readonly code: XhsOpsTakeoverParamConflictCode,
    readonly issues: XhsOpsTakeoverPlanIssue[],
    message: string,
  ) {
    super(409, message);
    this.name = "XhsOpsTakeoverParamError";
  }
}

/** A comment run refused because the takeover is paused (§6.5): the route adds code "takeover_paused". */
export class XhsOpsTakeoverPausedError extends XhsOpsError {
  readonly code = "takeover_paused" as const;
  constructor(message: string) {
    super(409, message);
    this.name = "XhsOpsTakeoverPausedError";
  }
}

export function localDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
