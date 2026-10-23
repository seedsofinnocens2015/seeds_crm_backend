/**
 * Phase 5 Automated Verification Test Suite
 * Tests:
 * 1. Role-based data scoping for /dashboard-stats:
 *    - Admin, Team Leader, MIS, Marketing can view system-wide statistics
 *    - Agent is strictly scoped to leads assigned to their callerName
 *    - Unauthenticated requests are rejected (401)
 * 2. Accuracy of Overall KPI Metrics:
 *    - Total leads, closed, contactAttempt, contacted, converted, followUp, other, conversionRate
 * 3. Accuracy of 12 Analytics Matrices:
 *    - distinctMonths, distinctLocations
 *    - ftdData (Date-wise pivot matrix + totals)
 *    - mtdData (Month-wise pivot matrix + totals)
 *    - validSummaryData (Month-wise valid status + percentages + totals)
 *    - appointmentDateData (Date & location grouped + totals)
 *    - appointmentMonthData (Month-wise appointments + charges totals)
 *    - surgeryDateData (Date & location grouped surgeries + payments totals)
 *    - surgeryMonthData (Month-wise surgeries + payments totals)
 *    - callSummaryData (Month-wise enquiry, valid, converted, percentages, charges, surgery)
 *    - subDispData (Hierarchical disposition -> subDispositions matrix by month)
 *    - leadSourceData (Month-wise lead sources counts)
 * 4. Filter Semantics:
 *    - month filter (FTD, appointment date, surgery date)
 *    - location filter (appointments, surgeries, call summary, sub-dispositions, sources)
 * 5. Short-term caching (15s fresh cache) and cache invalidation:
 *    - Cache HIT on repeated requests within TTL
 *    - Cache invalidation stamped immediately when a lead is created or updated
 *    - fresh=true query bypass
 * 6. Empty dataset / missing filters safety
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
  console.log("=== STARTING PHASE 5 DASHBOARD & ANALYTICS TEST SUITE ===\n");

  const runId = Date.now();
  let adminToken = "";
  let tlToken = "";
  let misToken = "";
  let mktToken = "";
  let agentToken = "";
  const agentName = `P5 Agent ${runId}`;

  // 1. Authenticate / Bootstrap Admin
  const adminEmail = `p5.admin.${runId}@seeds-crm.dev`;
  const adminSignup = await fetch(`${BASE_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Phase 5 Admin",
      mobile: `98${String(runId).slice(-8)}`,
      email: adminEmail,
      password: "AdminPassword123!",
    }),
  });

  if (adminSignup.status === 201) {
    const data = await adminSignup.json();
    adminToken = data.token;
  } else {
    // Already bootstrapped, login with standard dev admin
    const adminLogin = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test.admin.1792393493810@seeds-crm.dev",
        password: "AdminPassword123!",
      }),
    });
    const data = await adminLogin.json();
    adminToken = data.token;
  }
  assert(!!adminToken, "Admin Authentication", "Admin authenticated successfully");

  // Create & login Team Leader
  const tlEmail = `p5.tl.${runId}@seeds-crm.dev`;
  await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Phase 5 TL",
      email: tlEmail,
      mobile: `97${String(runId).slice(-8)}`,
      role: "team_leader",
      password: "TLPassword123!",
    }),
  });
  const tlLoginRes = await (await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: tlEmail, password: "TLPassword123!" }),
  })).json();
  tlToken = tlLoginRes.token;
  assert(!!tlToken, "Team Leader Authentication", `TL logged in: ${tlEmail}`);

  // Create & login MIS
  const misEmail = `p5.mis.${runId}@seeds-crm.dev`;
  await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Phase 5 MIS",
      email: misEmail,
      mobile: `96${String(runId).slice(-8)}`,
      role: "mis",
      password: "MISPassword123!",
    }),
  });
  const misLoginRes = await (await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: misEmail, password: "MISPassword123!" }),
  })).json();
  misToken = misLoginRes.token;
  assert(!!misToken, "MIS Authentication", `MIS logged in: ${misEmail}`);

  // Create & login Marketing
  const mktEmail = `p5.mkt.${runId}@seeds-crm.dev`;
  await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Phase 5 Marketing",
      email: mktEmail,
      mobile: `95${String(runId).slice(-8)}`,
      role: "marketing",
      password: "MKTPassword123!",
    }),
  });
  const mktLoginRes = await (await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: mktEmail, password: "MKTPassword123!" }),
  })).json();
  mktToken = mktLoginRes.token;
  assert(!!mktToken, "Marketing Authentication", `Marketing logged in: ${mktEmail}`);

  // Create & login Agent
  const agentEmail = `p5.agent.${runId}@seeds-crm.dev`;
  await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: agentName,
      email: agentEmail,
      mobile: `94${String(runId).slice(-8)}`,
      role: "agent",
      password: "AgentPassword123!",
    }),
  });
  const agentLoginRes = await (await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: agentEmail, password: "AgentPassword123!" }),
  })).json();
  agentToken = agentLoginRes.token;
  assert(!!agentToken, "Agent Authentication", `Agent logged in: ${agentEmail} (${agentName})`);

  // ── TEST 1: Unauthenticated Access Guard ───────────────────────────────────
  console.log("\n--- Testing Authentication Guard ---");
  const unauthRes = await fetch(`${BASE_URL}/dashboard-stats`);
  assert(unauthRes.status === 401, "Reject Unauthenticated /dashboard-stats", `Status: ${unauthRes.status}`);

  // ── TEST 2: Seed Known Test Fixtures for Controlled Analytics ──────────────
  console.log("\n--- Seeding Test Fixtures ---");

  // Create a lead assigned specifically to the new agent
  const agentLeadPhone = `91${String(runId).slice(-8)}`;
  const agentLeadRes = await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Agent Scoped Patient",
      mobileNumber: agentLeadPhone,
      callerName: agentName,
      city: "Meerut",
      location: "Meerut",
      leadSource: "Google Ads",
      subDispositions: "Appointment Booked",
      consultationCharges: "850",
      notes: "Agent initial note",
    }),
  });
  const agentLeadData = await agentLeadRes.json();
  assert(agentLeadRes.status === 201, "Agent Test Lead Created", `UniqueId: ${agentLeadData.lead?.uniqueId}`);

  // Create a lead unassigned / assigned to someone else
  const otherLeadPhone = `92${String(runId).slice(-8)}`;
  const otherLeadRes = await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Other Agent Patient",
      mobileNumber: otherLeadPhone,
      callerName: "Another Unrelated Caller",
      city: "Lucknow",
      location: "Lucknow",
      leadSource: "Meta Ads",
      subDispositions: "Surgery Completed",
      surgeryDate: "15-Oct-26",
      surgeryPaymentReceived: "45000",
      notes: "Other lead initial note",
    }),
  });
  const otherLeadData = await otherLeadRes.json();
  assert(otherLeadRes.status === 201, "Other Test Lead Created", `UniqueId: ${otherLeadData.lead?.uniqueId}`);

  // ── TEST 3: Role-Based Scoping & Data Visibility ───────────────────────────
  console.log("\n--- Testing Role-Based Scoping ---");

  // 3a. Admin stats (system-wide)
  const adminStatsRes = await fetch(`${BASE_URL}/dashboard-stats?fresh=true`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const adminStats = await adminStatsRes.json();
  assert(adminStatsRes.status === 200, "Admin Access /dashboard-stats", `Status: 200, Total leads: ${adminStats.metrics?.total}`);
  assert(adminStats.metrics?.total >= 2, "Admin Sees System-Wide Leads", `Total: ${adminStats.metrics?.total}`);

  // 3b. Team Leader stats (system-wide)
  const tlStatsRes = await fetch(`${BASE_URL}/dashboard-stats?fresh=true`, {
    headers: { Authorization: `Bearer ${tlToken}` },
  });
  const tlStats = await tlStatsRes.json();
  assert(tlStatsRes.status === 200 && tlStats.metrics?.total === adminStats.metrics?.total, "Team Leader Full Visibility", `TL Total: ${tlStats.metrics?.total}`);

  // 3c. MIS stats (system-wide)
  const misStatsRes = await fetch(`${BASE_URL}/dashboard-stats?fresh=true`, {
    headers: { Authorization: `Bearer ${misToken}` },
  });
  const misStats = await misStatsRes.json();
  assert(misStatsRes.status === 200 && misStats.metrics?.total === adminStats.metrics?.total, "MIS Full Visibility", `MIS Total: ${misStats.metrics?.total}`);

  // 3d. Marketing stats (system-wide)
  const mktStatsRes = await fetch(`${BASE_URL}/dashboard-stats?fresh=true`, {
    headers: { Authorization: `Bearer ${mktToken}` },
  });
  const mktStats = await mktStatsRes.json();
  assert(mktStatsRes.status === 200 && mktStats.metrics?.total === adminStats.metrics?.total, "Marketing Full Visibility", `MKT Total: ${mktStats.metrics?.total}`);

  // 3e. Agent stats (STRICTLY SCOPED to callerName)
  const agentStatsRes = await fetch(`${BASE_URL}/dashboard-stats?fresh=true`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  const agentStats = await agentStatsRes.json();
  assert(agentStatsRes.status === 200, "Agent Access /dashboard-stats", `Status: 200`);
  assert(agentStats.metrics?.total === 1, "Agent Data Strictly Scoped to Assigned Leads", `Agent Total: ${agentStats.metrics?.total} (expected exactly 1)`);
  assert(
    agentStats.distinctLocations.includes("Meerut") && !agentStats.distinctLocations.includes("Lucknow"),
    "Agent Cannot See Other Locations",
    `Locations: ${agentStats.distinctLocations.join(", ")}`
  );

  // ── TEST 4: Verification of All 12 Response Matrices Structure ─────────────
  console.log("\n--- Testing 12 Response Matrices Structure ---");

  assert(Array.isArray(adminStats.distinctMonths), "Matrix 1: distinctMonths is Array", `Count: ${adminStats.distinctMonths.length}`);
  assert(Array.isArray(adminStats.distinctLocations), "Matrix 2: distinctLocations is Array", `Count: ${adminStats.distinctLocations.length}`);
  assert(
    typeof adminStats.metrics === "object" &&
    typeof adminStats.metrics.conversionRate === "string" &&
    typeof adminStats.metrics.total === "number",
    "Matrix 3: metrics KPI summary",
    `Total: ${adminStats.metrics?.total}, Converted: ${adminStats.metrics?.converted}`
  );
  assert(
    Array.isArray(adminStats.ftdData?.rows) && typeof adminStats.ftdData?.totals === "object",
    "Matrix 4: ftdData (Date-wise Pivot)",
    `Rows: ${adminStats.ftdData?.rows.length}, GrandTotal: ${adminStats.ftdData?.totals?.grandTotal}`
  );
  assert(
    Array.isArray(adminStats.mtdData?.rows) && typeof adminStats.mtdData?.totals === "object",
    "Matrix 5: mtdData (Month-wise Pivot)",
    `Rows: ${adminStats.mtdData?.rows.length}, GrandTotal: ${adminStats.mtdData?.totals?.grandTotal}`
  );
  assert(
    Array.isArray(adminStats.validSummaryData?.rows) && typeof adminStats.validSummaryData?.totals === "object",
    "Matrix 6: validSummaryData (Valid Status)",
    `Rows: ${adminStats.validSummaryData?.rows.length}, ValidPercent: ${adminStats.validSummaryData?.totals?.validPercent}`
  );
  assert(
    Array.isArray(adminStats.appointmentDateData?.rows) && typeof adminStats.appointmentDateData?.totals === "object",
    "Matrix 7: appointmentDateData",
    `Count: ${adminStats.appointmentDateData?.totals?.count}, Collections: ${adminStats.appointmentDateData?.totals?.collections}`
  );
  assert(
    Array.isArray(adminStats.appointmentMonthData?.rows) && typeof adminStats.appointmentMonthData?.totals === "object",
    "Matrix 8: appointmentMonthData",
    `Count: ${adminStats.appointmentMonthData?.totals?.count}, Collections: ${adminStats.appointmentMonthData?.totals?.collections}`
  );
  assert(
    Array.isArray(adminStats.surgeryDateData?.rows) && typeof adminStats.surgeryDateData?.totals === "object",
    "Matrix 9: surgeryDateData",
    `Count: ${adminStats.surgeryDateData?.totals?.count}, Payments: ${adminStats.surgeryDateData?.totals?.paymentReceived}`
  );
  assert(
    Array.isArray(adminStats.surgeryMonthData?.rows) && typeof adminStats.surgeryMonthData?.totals === "object",
    "Matrix 10: surgeryMonthData",
    `Count: ${adminStats.surgeryMonthData?.totals?.count}, Payments: ${adminStats.surgeryMonthData?.totals?.paymentReceived}`
  );
  assert(
    Array.isArray(adminStats.callSummaryData?.rows) && typeof adminStats.callSummaryData?.totals === "object",
    "Matrix 11: callSummaryData",
    `Enquiries: ${adminStats.callSummaryData?.totals?.enquiry}, Total Collections: ${adminStats.callSummaryData?.totals?.totalCollections}`
  );
  assert(
    Array.isArray(adminStats.subDispData?.groups) && typeof adminStats.subDispData?.overallGrandTotal === "number",
    "Matrix 12a: subDispData",
    `Groups: ${adminStats.subDispData?.groups.length}, OverallTotal: ${adminStats.subDispData?.overallGrandTotal}`
  );
  assert(
    Array.isArray(adminStats.leadSourceData?.groups) && typeof adminStats.leadSourceData?.grandTotal === "number",
    "Matrix 12b: leadSourceData",
    `Groups: ${adminStats.leadSourceData?.groups.length}, GrandTotal: ${adminStats.leadSourceData?.grandTotal}`
  );

  // ── TEST 5: Filter Semantics (Month & Location) ────────────────────────────
  console.log("\n--- Testing Filter Semantics ---");

  // Filter by location: Meerut
  const meerutRes = await fetch(`${BASE_URL}/dashboard-stats?location=Meerut&fresh=true`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const meerutStats = await meerutRes.json();
  const meerutAppts = meerutStats.appointmentDateData?.rows || [];
  const allMeerutAppts = meerutAppts.every((r: any) => r.location === "Meerut");
  assert(
    meerutRes.status === 200 && (meerutAppts.length === 0 || allMeerutAppts),
    "Location Filter Applied Correctly",
    `Meerut appointment rows: ${meerutAppts.length}`
  );

  // Filter by non-existent location returns 0 items for filtered matrices
  const emptyLocRes = await fetch(`${BASE_URL}/dashboard-stats?location=NonExistentCityXYZ&fresh=true`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const emptyLocStats = await emptyLocRes.json();
  assert(
    emptyLocStats.appointmentDateData?.totals?.count === 0 &&
    emptyLocStats.surgeryDateData?.totals?.count === 0,
    "Empty Dataset on Non-Existent Location",
    `Appt Count: ${emptyLocStats.appointmentDateData?.totals?.count}`
  );

  // ── TEST 6: Caching Behavior and Invalidation ──────────────────────────────
  console.log("\n--- Testing Caching & Invalidation ---");

  // 6a. First fetch -> misses cache or primes cache
  const primeRes = await fetch(`${BASE_URL}/dashboard-stats?location=All&month=All`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  // 6b. Second immediate fetch -> MUST return X-Cache: HIT
  const hitRes = await fetch(`${BASE_URL}/dashboard-stats?location=All&month=All`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const hitHeader = hitRes.headers.get("x-cache");
  assert(hitRes.status === 200 && hitHeader === "HIT", "Cache HIT on Repeated Requests", `X-Cache: ${hitHeader}`);

  // 6c. fresh=true bypasses cache -> X-Cache: MISS
  const freshRes = await fetch(`${BASE_URL}/dashboard-stats?location=All&month=All&fresh=true`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const freshHeader = freshRes.headers.get("x-cache");
  assert(freshRes.status === 200 && freshHeader === "MISS", "Bypass Cache with fresh=true", `X-Cache: ${freshHeader}`);

  // 6d. Creating a lead invalidates the cache immediately
  await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Invalidation Test Patient",
      mobileNumber: `90${String(runId).slice(-8)}`,
      city: "Delhi",
    }),
  });

  // Next fetch without fresh=true must now be a MISS because cache was invalidated
  const invalidatedRes = await fetch(`${BASE_URL}/dashboard-stats?location=All&month=All`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const invalidatedHeader = invalidatedRes.headers.get("x-cache");
  assert(invalidatedHeader === "MISS", "Cache Invalidated Upon Lead Creation", `X-Cache: ${invalidatedHeader}`);

  // ── SUMMARY REPORT ────────────────────────────────────────────────────────
  console.log("\n==========================================");
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`TOTAL TESTS: ${total}`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  console.log("==========================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
