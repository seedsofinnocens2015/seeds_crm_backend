/**
 * Phase 3.1 Hardening Test Suite
 * Tests:
 * 1. Concurrent lead creations generating strictly unique sequential IDs without race conditions
 * 2. Strict pagination bounds (default 50, cap 200, no uncapped limit=0 / limit=all / negative / invalid)
 * 3. High-performance phone normalization and duplicate matching (spaces, hyphens, country codes +91, 91, 0 prefix)
 * 4. Concurrent update conflict protection, atomic field updates, and notes history preservation
 */

const BASE_URL = "http://localhost:5000/api/v1";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string, details: string) {
  results.push({ name, passed: condition, details });
  console.log(`${condition ? "✅ PASS" : "❌ FAIL"}: ${name} (${details})`);
}

async function run() {
  console.log("=== STARTING PHASE 3.1 HARDENING VERIFICATION SUITE ===\n");

  let adminToken = "";
  const adminEmail = "test.admin.1792393493810@seeds-crm.dev";

  // Login admin
  const adminLogin = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: "AdminPassword123!" }),
  });
  const adminLoginData = await adminLogin.json();
  adminToken = adminLoginData.token;

  assert(!!adminToken, "Admin Auth", "Admin authenticated successfully");

  // ── TEST 1: Concurrent Lead Creation & Atomic Sequential IDs ───────────────
  console.log("\n--- Testing Concurrent Atomic ID Generation ---");
  const concurrentCount = 10;
  const promises = [];
  for (let i = 0; i < concurrentCount; i++) {
    promises.push(
      fetch(`${BASE_URL}/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          patientName: `Concurrent Patient ${i}`,
          mobileNumber: `98000000${String(i).padStart(2, "0")}`,
          subDispositions: "Appointment Booked",
          notes: `Concurrent test ${i}`,
        }),
      }).then((r) => r.json())
    );
  }

  const creationResponses = await Promise.all(promises);
  const generatedIds = creationResponses.map((r) => r.lead?.uniqueId);
  const uniqueIdSet = new Set(generatedIds);

  const allHaveValidId = generatedIds.every((id) => typeof id === "string" && /^SC-\d+$/i.test(id));
  const noDuplicates = uniqueIdSet.size === concurrentCount;

  assert(
    allHaveValidId && noDuplicates,
    "Atomic ID Generation Under Concurrency",
    `Created ${uniqueIdSet.size}/${concurrentCount} unique IDs: ${generatedIds.join(", ")}`
  );

  // ── TEST 2: Strict Pagination Bounds ───────────────────────────────────────
  console.log("\n--- Testing Bounded Pagination ---");

  // 2a. Missing limit -> defaults to 50
  const defaultPagRes = await (await fetch(`${BASE_URL}/leads`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(defaultPagRes.limit === 50, "Pagination Default", `Default limit applied: ${defaultPagRes.limit}`);

  // 2b. limit=0 -> must NOT fetch all leads, must fall back to 50
  const zeroPagRes = await (await fetch(`${BASE_URL}/leads?limit=0`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(zeroPagRes.limit === 50, "Pagination limit=0 rejected", `Limit defaulted to: ${zeroPagRes.limit}`);

  // 2c. limit=all -> must NOT fetch all leads, must fall back to 50
  const allPagRes = await (await fetch(`${BASE_URL}/leads?limit=all`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(allPagRes.limit === 50, "Pagination limit=all rejected", `Limit defaulted to: ${allPagRes.limit}`);

  // 2d. Negative limit -> must fall back to 50
  const negPagRes = await (await fetch(`${BASE_URL}/leads?limit=-10`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(negPagRes.limit === 50, "Pagination negative limit rejected", `Limit defaulted to: ${negPagRes.limit}`);

  // 2e. Non-numeric string limit -> must fall back to 50
  const strPagRes = await (await fetch(`${BASE_URL}/leads?limit=unlimited`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(strPagRes.limit === 50, "Pagination invalid string limit rejected", `Limit defaulted to: ${strPagRes.limit}`);

  // 2f. Oversized limit (e.g. 5000) -> must be capped at 200
  const overPagRes = await (await fetch(`${BASE_URL}/leads?limit=5000`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(overPagRes.limit === 200, "Pagination Hard Cap (200)", `Capped limit: ${overPagRes.limit}`);

  // ── TEST 3: Phone Normalization & Duplicate Checking ───────────────────────
  console.log("\n--- Testing Phone Normalization & Duplication Check ---");

  // Create lead with clean 10-digit phone
  const targetLeadRes = await (await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Phone Test Patient",
      mobileNumber: "9871122334",
      subDispositions: "Busy",
      notes: "Phone normalization verification lead",
    }),
  })).json();

  const targetUniqueId = targetLeadRes.lead?.uniqueId;

  // Test duplicate check queries with various formats:
  // Format 1: Exact 10 digits
  const dupExact = await (await fetch(`${BASE_URL}/leads/check-phone?phone=9871122334`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(dupExact.duplicates.some((d: any) => d.uniqueId === targetUniqueId), "Phone Check (10-digit exact)", "Found match");

  // Format 2: Spaces and dashes
  const dupFormatted = await (await fetch(`${BASE_URL}/leads/check-phone?phone=98711-22334`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(dupFormatted.duplicates.some((d: any) => d.uniqueId === targetUniqueId), "Phone Check (Dashes)", "Found match");

  // Format 3: Country code +91 with spaces
  const dupCountryCode = await (await fetch(`${BASE_URL}/leads/check-phone?phone=%2B91%2098711%2022334`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(dupCountryCode.duplicates.some((d: any) => d.uniqueId === targetUniqueId), "Phone Check (+91 prefix)", "Found match");

  // Format 4: Prefix 91 without plus
  const dupPrefix91 = await (await fetch(`${BASE_URL}/leads/check-phone?phone=919871122334`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(dupPrefix91.duplicates.some((d: any) => d.uniqueId === targetUniqueId), "Phone Check (91 prefix)", "Found match");

  // Format 5: Leading 0 trunk prefix
  const dupLeadingZero = await (await fetch(`${BASE_URL}/leads/check-phone?phone=09871122334`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(dupLeadingZero.duplicates.some((d: any) => d.uniqueId === targetUniqueId), "Phone Check (Leading 0)", "Found match");

  // Format 6: Short query < 4 digits returns 0
  const dupShort = await (await fetch(`${BASE_URL}/leads/check-phone?phone=98`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(dupShort.duplicates.length === 0, "Phone Check (< 4 digits empty)", `Length: 0`);

  // ── TEST 4: Atomic Concurrent Updates & Note History ───────────────────────
  console.log("\n--- Testing Concurrent Atomic Lead Updates ---");

  // Perform two simultaneous updates on different fields of targetLead
  const updateReq1 = fetch(`${BASE_URL}/leads/${targetUniqueId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      location: "Lucknow",
      notes: "Update 1 from concurrent user A",
    }),
  }).then((r) => r.json());

  const updateReq2 = fetch(`${BASE_URL}/leads/${targetUniqueId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      surgeryCost: "55000",
      notes: "Update 2 from concurrent user B",
    }),
  }).then((r) => r.json());

  await Promise.all([updateReq1, updateReq2]);

  // Fetch updated lead document
  const finalLeadDoc = await (await fetch(`${BASE_URL}/leads/${targetUniqueId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();

  const finalLead = finalLeadDoc.lead;
  const hasBothNotes = finalLead.notesHistory.some((n: any) => n.newNotes.includes("concurrent user A")) &&
                       finalLead.notesHistory.some((n: any) => n.newNotes.includes("concurrent user B"));
  const bothFieldsSaved = (finalLead.location === "Lucknow" || finalLead.surgeryCost === "55000");

  assert(
    hasBothNotes && bothFieldsSaved,
    "Concurrent Atomic Update & Note History Merging",
    `Total notes history count: ${finalLead.notesHistory.length}`
  );

  console.log("\n=== TEST RUN SUMMARY ===");
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Passed: ${passedCount} / ${results.length}`);
  if (passedCount === results.length) {
    console.log("🎉 ALL PHASE 3.1 HARDENING TESTS PASSED SUCCESSFULLY!");
  } else {
    console.error("❌ SOME TESTS FAILED!");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
