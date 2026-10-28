import { Counter } from "../models/Counter.js";
import { Lead } from "../models/Lead.js";

const COUNTER_ID = "lead_unique_id";

/**
 * Finds the actual highest sequential lead number from the database collection.
 * Scans existing leads and matches patterns like SOI-123.
 * Returns 0 if no matching leads exist.
 */
async function getActualMaxLeadNumberFromDb(): Promise<number> {
  const totalLeads = await Lead.countDocuments();
  if (totalLeads === 0) {
    return 0;
  }

  // Scan leads to find the actual maximum numeric suffix for SOI-<num>
  const leads = await Lead.find(
    { uniqueId: { $regex: /^(?:SOI|SC)-\d+$/i } },
    { uniqueId: 1 }
  )
    .sort({ createdAt: -1 })
    .limit(2000)
    .lean();

  let maxNum = 0;
  for (const l of leads) {
    if (l.uniqueId) {
      const match = l.uniqueId.match(/^(?:SOI|SC)-(\d+)$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        // Exclude huge arbitrary numbers / timestamps (e.g. > 10,000,000)
        if (num < 10000000 && num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  return maxNum;
}

/**
 * Synchronizes and validates the Counter sequence with the actual Leads collection.
 * If the database is blank (0 leads), ensures counter is set to 0.
 * If leads exist, ensures counter is at least equal to the highest lead number.
 */
async function syncCounterWithDatabase(): Promise<number> {
  const actualMax = await getActualMaxLeadNumberFromDb();

  const existingCounter = await Counter.findById(COUNTER_ID);
  
  // If no leads exist in DB, force counter seq to 0 so the first lead is SOI-1
  if (actualMax === 0) {
    if (!existingCounter || existingCounter.seq !== 0) {
      await Counter.findByIdAndUpdate(
        COUNTER_ID,
        { $set: { seq: 0 } },
        { upsert: true, new: true }
      );
    }
    return 0;
  }

  // If leads exist, ensure counter is not lagging behind actual max
  if (!existingCounter || existingCounter.seq < actualMax) {
    const updated = await Counter.findByIdAndUpdate(
      COUNTER_ID,
      { $set: { seq: actualMax } },
      { upsert: true, new: true }
    );
    return updated?.seq ?? actualMax;
  }

  return existingCounter.seq;
}

/**
 * Returns the current expected next unique ID WITHOUT incrementing the counter.
 * Safe for previews, GET requests, page loads, and refreshing.
 * If database is blank, preview will show SOI-1.
 */
export async function peekNextUniqueId(): Promise<string> {
  const currentSeq = await syncCounterWithDatabase();
  return `SOI-${currentSeq + 1}`;
}

/**
 * Generates the next sequential unique ID in the format SOI-<number> atomically.
 * MUST ONLY be called when actually creating and persisting a new lead.
 * Guarantees serial progression: SOI-1, SOI-2, SOI-3, etc.
 */
export async function getNextUniqueId(): Promise<string> {
  await syncCounterWithDatabase();

  const counter = await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `SOI-${counter.seq}`;
}

/**
 * Resets the counter sequence to match the actual highest lead ID in the database.
 * If there are no leads, resets to 0 (so next lead will start from SOI-1).
 */
export async function resetCounterToActualMax(): Promise<number> {
  const maxNum = await getActualMaxLeadNumberFromDb();

  await Counter.findByIdAndUpdate(
    COUNTER_ID,
    { $set: { seq: maxNum } },
    { upsert: true, new: true }
  );

  return maxNum;
}

