/**
 * Session keys of restricted text-generation turns (takeover §4.1).
 *
 * The toolcall guard matches this key shape before anything else
 * (RESTRICTED_TEXT_SESSION_KEY_PATTERN) and gives the turn its own reason,
 * `restricted-text-origin`, on the restricted tier. No per-bot host-execution
 * switch accepts that reason, so device_*, exec, sessions_send and every other
 * unreviewed tool stay refused whatever the bot's `automations` / `channels`
 * setting, and a sub-session spawned from the turn inherits the same reason.
 * Nexu schedules (`agent:<bot>:schedule-<scheduleId>`) keep the ordinary
 * automation reason; the `textgen-` marker is what keeps the two apart. Like
 * the textgen subagent lane these turns are internal machinery, not
 * conversations, and stay out of the session lists (gateway-session-reader,
 * sessions-runtime).
 */
const RESTRICTED_TEXT_SESSION_MARKER = ":schedule-textgen-";

export function restrictedTextSessionKey(
  botId: string,
  lane: string,
  id: string,
): string {
  return `agent:${botId}${RESTRICTED_TEXT_SESSION_MARKER}${lane}-${id}`;
}

export function isRestrictedTextSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(RESTRICTED_TEXT_SESSION_MARKER);
}
