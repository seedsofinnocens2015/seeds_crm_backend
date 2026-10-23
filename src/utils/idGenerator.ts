import { Counter } from "../models/Counter.js";
import { Lead } from "../models/Lead.js";

const COUNTER_ID = "lead_unique_id";

/**
 * Initializes the atomic counter if it does not already exist.
 * Scans the highest current valid SC-<number> to ensure no duplicate IDs are generated.
 */
async function initializeCounterIfNeeded(): Promise<number> {
  const existingCounter = await Counter.findById(COUNTER_ID);
  if (existingCounter) {
    return existingCounter.seq;
  }

  // Scan recent highest leads to determine highest existing SC number
  const recentLeads = await Lead.find(
    { uniqueId: { $regex: /^SC-\d+$/i } },
    { uniqueId: 1 }
  )
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  let maxNum = 0;
  for (const l of recentLeads) {
    if (l.uniqueId) {
      const match = l.uniqueId.match(/^SC-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }

  if (maxNum === 0) {
    maxNum = await Lead.countDocuments();
  }

  // Atomically upsert counter if not exists
  const initialized = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $setOnInsert: { seq: maxNum } },
    { upsert: true, new: true }
  );

  return initialized?.seq || maxNum;
}

/**
 * Generates the next sequential unique ID in the format SC-<number> atomically.
 * Uses MongoDB findOneAndUpdate with $inc so concurrent workers never get the same ID.
 */
export async function getNextUniqueId(): Promise<string> {
  await initializeCounterIfNeeded();

  const counter = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `SC-${counter.seq}`;
}
