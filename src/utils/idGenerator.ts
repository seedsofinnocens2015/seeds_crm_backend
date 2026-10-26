import { Counter } from "../models/Counter.js";
import { Lead } from "../models/Lead.js";

const COUNTER_ID = "lead_unique_id";

/**
 * Initializes the atomic counter if it does not already exist.
 * Scans the highest current valid SOI-<number> or SC-<number> to ensure no duplicate IDs are generated.
 */
async function initializeCounterIfNeeded(): Promise<number> {
  const existingCounter = await Counter.findById(COUNTER_ID);
  if (existingCounter && existingCounter.seq > 0) {
    return existingCounter.seq;
  }

  // Find all leads with any uniqueId to find the maximum sequential integer ID
  const recentLeads = await Lead.find(
    {},
    { uniqueId: 1 }
  )
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  let maxNum = 0;
  for (const l of recentLeads) {
    if (l.uniqueId) {
      // Matches SOI-1, SC-1, etc. (pure sequential integers)
      // Excludes year formats like SOI-2026-0001
      const match = l.uniqueId.match(/^(?:SOI|SC)-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        // If it was an old 2026xxxx year-based number (> 20000000), ignore it
        if (num < 20000000 && num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  // Atomically upsert counter
  const initialized = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $set: { seq: maxNum } },
    { upsert: true, new: true }
  );

  return initialized?.seq || maxNum;
}

/**
 * Generates the next sequential unique ID in the format SOI-<number> atomically.
 */
export async function getNextUniqueId(): Promise<string> {
  await initializeCounterIfNeeded();

  const counter = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `SOI-${counter.seq}`;
}
