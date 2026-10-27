import { config } from "../../config/env.js";
import { runPendingSmartfloJobs } from "./smartfloSyncService.js";
import { syncSmartfloCdrRange } from "./smartfloCdrService.js";

let queueIntervalTimer: NodeJS.Timeout | null = null;
let cdrIntervalTimer: NodeJS.Timeout | null = null;
let isQueueRunning = false;
let isCdrRunning = false;

function formatDateTimeYMDHMS(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Executes a single locked cycle of the pending Smartflo jobs queue.
 */
export async function executeQueueCycle(limit: number = 50): Promise<number> {
  if (!config.smartfloSyncEnabled || !config.smartfloApiToken) {
    return 0;
  }
  if (isQueueRunning) {
    return 0;
  }

  isQueueRunning = true;
  try {
    return await runPendingSmartfloJobs(limit);
  } catch (err: any) {
    console.error("[Smartflo Worker] Queue cycle error:", err.message);
    return 0;
  } finally {
    isQueueRunning = false;
  }
}

/**
 * Executes a single locked cycle of CDR reconciliation for the trailing 2-hour window.
 */
export async function executeCdrReconciliationCycle(): Promise<void> {
  if (!config.smartfloSyncEnabled || !config.smartfloApiToken) {
    return;
  }
  if (isCdrRunning) {
    return;
  }

  isCdrRunning = true;
  try {
    const now = new Date();
    // 2 hours window with overlap to guarantee no missed call events
    const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const fromStr = formatDateTimeYMDHMS(from);
    const toStr = formatDateTimeYMDHMS(now);

    const summary = await syncSmartfloCdrRange(fromStr, toStr);
    if (summary.processed > 0) {
      console.log(`[Smartflo CDR Scheduler] Reconciled ${summary.processed} records (${summary.synced} matched to leads).`);
    }
  } catch (err: any) {
    console.error("[Smartflo CDR Scheduler] Reconciliation error:", err.message);
  } finally {
    isCdrRunning = false;
  }
}

/**
 * Starts the Smartflo background workers (Queue polling + CDR reconciliation).
 * Only activates when SMARTFLO_SYNC_ENABLED is true.
 */
export function startSmartfloScheduler(): void {
  if (!config.smartfloSyncEnabled) {
    return;
  }

  // Queue runner: poll every 30 seconds
  if (!queueIntervalTimer) {
    queueIntervalTimer = setInterval(() => {
      executeQueueCycle().catch((err) => {
        console.error("[Smartflo Worker] Unhandled queue loop error:", err.message);
      });
    }, 30000);
    queueIntervalTimer.unref();

    // Trigger an initial run shortly after startup
    setTimeout(() => {
      executeQueueCycle().catch(() => {});
    }, 3000).unref();
  }

  // CDR reconciliation: run every 60 minutes
  if (!cdrIntervalTimer) {
    cdrIntervalTimer = setInterval(() => {
      executeCdrReconciliationCycle().catch((err) => {
        console.error("[Smartflo CDR Scheduler] Unhandled CDR loop error:", err.message);
      });
    }, 60 * 60 * 1000);
    cdrIntervalTimer.unref();
  }

  console.log("[Smartflo Worker] Background queue and CDR scheduler registered successfully.");
}

/**
 * Stops the Smartflo background workers gracefully during process termination.
 */
export function stopSmartfloScheduler(): void {
  if (queueIntervalTimer) {
    clearInterval(queueIntervalTimer);
    queueIntervalTimer = null;
  }
  if (cdrIntervalTimer) {
    clearInterval(cdrIntervalTimer);
    cdrIntervalTimer = null;
  }
}
