import { logger } from "../lib/logger.js";
import type {
  XhsOpsStore,
  XhsOpsTakeoverRecovery,
} from "../store/xhs-ops-store.js";
import type { XhsOpsAuditService } from "./xhs-ops-audit-service.js";
import type { XhsOpsChangeOrderService } from "./xhs-ops-change-order-service.js";

/**
 * Whether this process's startup recovery has settled. The HTTP server
 * answers before bootstrap reaches startBackgroundLoops, and until the sweep
 * ran the store still shows the previous process's work as running: the
 * sweep would take an audit, diagnosis or change order started now for one
 * of those — an apply marked interrupted and its live phone task stopped —
 * and a reconcile still under way could hold the device for a new task. So
 * the takeover routes that start or advance work answer 503 until this is
 * settled. Absent (tests that register the routes alone) means no recovery
 * is pending.
 */
export interface XhsOpsTakeoverRecoveryState {
  settled: boolean;
}

export interface XhsOpsTakeoverRecoveryDeps {
  store: Pick<XhsOpsStore, "recoverInterruptedTakeoverWork">;
  audits: Pick<XhsOpsAuditService, "reconcileInterruptedAudits">;
  changeOrders: Pick<XhsOpsChangeOrderService, "reconcileInterruptedOrders">;
  /** Marked settled once the sweep and both reconciles ended, whatever their outcome. */
  state?: XhsOpsTakeoverRecoveryState;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Startup recovery of the takeover work a previous controller left running
 * (takeover §2.6, §3.1 表二): the store sweep marks running audits
 * interrupted, fails generating diagnoses, puts prechecking change orders
 * back to draft and interrupts applying / verifying ones; the phone task
 * behind each audit and order is then stopped, reconciled or the device held.
 * Nothing is resumed.
 *
 * The sweep is queued on the store the moment this is called, so call it
 * before the scheduler and any other takeover work start. It never throws:
 * failures are logged with ids and counts only, and startup goes on. When it
 * ends, `deps.state` is settled — also after a failure, which leaves nothing
 * to wait for.
 */
export async function recoverXhsOpsTakeoverWork(
  deps: XhsOpsTakeoverRecoveryDeps,
): Promise<void> {
  try {
    await recover(deps);
  } finally {
    if (deps.state) deps.state.settled = true;
  }
}

async function recover(deps: XhsOpsTakeoverRecoveryDeps): Promise<void> {
  let recovery: XhsOpsTakeoverRecovery;
  try {
    recovery = await deps.store.recoverInterruptedTakeoverWork();
  } catch (error) {
    logger.warn(
      { error: describe(error) },
      "xhs-ops: takeover startup sweep failed",
    );
    return;
  }
  const { audits, diagnoses, changeOrders } = recovery;
  if (audits.length + diagnoses.length + changeOrders.length === 0) return;
  logger.info(
    {
      audits: audits.length,
      diagnoses: diagnoses.length,
      changeOrders: changeOrders.length,
    },
    "xhs-ops: takeover work interrupted by a controller restart",
  );
  if (audits.length > 0) {
    try {
      const outcomes = await deps.audits.reconcileInterruptedAudits(audits);
      logger.info(
        { outcomes },
        "xhs-ops: interrupted takeover audits reconciled",
      );
    } catch (error) {
      logger.warn(
        { error: describe(error) },
        "xhs-ops: interrupted takeover audit reconcile failed",
      );
    }
  }
  if (changeOrders.length > 0) {
    try {
      const outcomes =
        await deps.changeOrders.reconcileInterruptedOrders(changeOrders);
      logger.info(
        { outcomes },
        "xhs-ops: interrupted change orders reconciled",
      );
    } catch (error) {
      logger.warn(
        { error: describe(error) },
        "xhs-ops: interrupted change order reconcile failed",
      );
    }
  }
}
