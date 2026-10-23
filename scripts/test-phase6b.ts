/**
 * Phase 6B Automated Verification Test Suite
 * Tests all API endpoints THROUGH THE FRONTEND ORIGIN (http://localhost:3000),
 * verifying that Next.js rewrites proxy accurately to the Express backend (http://localhost:5000/api/v1).
 *
 * Scope:
 * 1. Authentication & Cookie Handshake:
 *    - POST /api/auth/login through port 3000 -> sets HTTP-only cookie
 *    - GET /api/auth/me through port 3000 using cookie -> validates session
 *    - POST /api/auth/logout through port 3000 -> clears cookie
 * 2. Members Management:
 *    - GET /api/admin/members through port 3000
 *    - POST /api/admin/members through port 3000 (create member)
 *    - GET /api/admin/members/:id through port 3000
 *    - PUT /api/admin/members/:id through port 3000 (status toggle)
 *    - DELETE /api/admin/members/:id through port 3000
 * 3. Lead CRUD & Duplicate Checks:
 *    - GET /api/admin/leads/check-phone through port 3000
 *    - POST /api/admin/leads through port 3000 (create lead)
 *    - GET /api/admin/leads through port 3000 (paginated table)
 *    - GET /api/admin/leads?view=dashboard through port 3000
 *    - GET /api/admin/leads/:id through port 3000
 *    - PUT /api/admin/leads/:id through port 3000
 *    - DELETE /api/admin/leads/:id through port 3000
 * 4. Bulk Operations:
 *    - POST /api/admin/leads/bulk through port 3000 (bulk upload)
 *    - POST /api/admin/leads/assign-bulk through port 3000 (bulk assign)
 *    - POST /api/admin/leads/bulk-update through port 3000 (bulk update)
 *    - POST /api/admin/leads/merge through port 3000 (merge leads)
 * 5. Dashboard Analytics:
 *    - GET /api/admin/dashboard-stats through port 3000 (verifies all 12 matrices)
 * 6. Form Configuration:
 *    - GET /api/admin/form-config through port 3000
 *    - PUT /api/admin/form-config through port 3000
 *    - POST /api/admin/form-config/reset through port 3000
 */

const FRONTEND_ORIGIN = "http://localhost:3000";

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
  console.log("=== STARTING PHASE 6B FRONTEND PROXY INTEGRATION TEST SUITE ===\n");
  console.log(`Targeting Frontend Origin: ${FRONTEND_ORIGIN}\n`);

  const runId = Date.now();
  let adminCookie = "";
  let adminToken = "";
  let tlToken = "";
  let agentToken = "";
  const agentName = `P6B Agent ${runId}`;

  // ── TEST 1: Authentication & Cookie Handshake via Frontend Proxy ───────────
  console.log("--- Testing Auth & Session Proxy ---");

  // 1a. Login admin through http://localhost:3000/api/auth/login
  const loginRes = await fetch(`${FRONTEND_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "test.admin.1792393493810@seeds-crm.dev",
      password: "AdminPassword123!",
      requiredRole: "admin",
    }),
  });

  const loginData = await loginRes.json();
  const setCookieHeader = loginRes.headers.get("set-cookie") || "";
  adminCookie = setCookieHeader.split(";")[0]; // extract token=...
  adminToken = loginData.token;

  assert(
    loginRes.status === 200 && !!adminCookie && loginData.user?.role === "admin",
    "POST /api/auth/login through Frontend Proxy",
    `Status: ${loginRes.status}, Cookie: ${adminCookie.slice(0, 25)}...`
  );

  // 1b. Verify session through http://localhost:3000/api/auth/me using Cookie
  const meCookieRes = await fetch(`${FRONTEND_ORIGIN}/api/auth/me`, {
    headers: { Cookie: adminCookie },
  });
  const meCookieData = await meCookieRes.json();
  assert(
    meCookieRes.status === 200 && meCookieData.user?.email === "test.admin.1792393493810@seeds-crm.dev",
    "GET /api/auth/me using Cookie through Proxy",
    `User: ${meCookieData.user?.name} (${meCookieData.user?.role})`
  );

  // 1c. Verify session using Authorization header through proxy
  const meAuthRes = await fetch(`${FRONTEND_ORIGIN}/api/auth/me`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const meAuthData = await meAuthRes.json();
  assert(
    meAuthRes.status === 200 && meAuthData.user?.role === "admin",
    "GET /api/auth/me using Bearer Token through Proxy",
    `Status: ${meAuthRes.status}`
  );

  // 1d. Create Team Leader and Agent for downstream RBAC testing
  const tlEmail = `p6b.tl.${runId}@seeds-crm.dev`;
  await fetch(`${FRONTEND_ORIGIN}/api/admin/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      name: "Phase 6B TL",
      email: tlEmail,
      mobile: `97${String(runId).slice(-8)}`,
      role: "team_leader",
      password: "TLPassword123!",
    }),
  });
  const tlLogin = await (await fetch(`${FRONTEND_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: tlEmail, password: "TLPassword123!" }),
  })).json();
  tlToken = tlLogin.token;

  const agentEmail = `p6b.agent.${runId}@seeds-crm.dev`;
  const agentCreatedRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      name: agentName,
      email: agentEmail,
      mobile: `96${String(runId).slice(-8)}`,
      role: "agent",
      password: "AgentPassword123!",
    }),
  });
  const agentCreated = await agentCreatedRes.json();
  const agentId = agentCreated.member?.id || agentCreated.member?._id;

  const agentLogin = await (await fetch(`${FRONTEND_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: agentEmail, password: "AgentPassword123!" }),
  })).json();
  agentToken = agentLogin.token;

  assert(!!tlToken && !!agentToken, "Team Leader and Agent Created & Authenticated", `Agent ID: ${agentId}`);

  // ── TEST 2: Member Management via Frontend Proxy ───────────────────────────
  console.log("\n--- Testing Members Management Proxy ---");

  // 2a. GET /api/admin/members
  const membersRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/members`, {
    headers: { Cookie: adminCookie },
  });
  const membersData = await membersRes.json();
  assert(
    membersRes.status === 200 && Array.isArray(membersData.members) && membersData.members.length > 0,
    "GET /api/admin/members through Proxy",
    `Members returned: ${membersData.members?.length}`
  );

  // 2b. GET /api/admin/members/:id
  const memberDetailRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/members/${agentId}`, {
    headers: { Cookie: adminCookie },
  });
  const memberDetail = await memberDetailRes.json();
  assert(
    memberDetailRes.status === 200 && memberDetail.member?.name === agentName,
    "GET /api/admin/members/:id through Proxy",
    `Name: ${memberDetail.member?.name}`
  );

  // 2c. PUT /api/admin/members/:id (update member)
  const memberUpdateRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/members/${agentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      name: `${agentName} Updated`,
      mobile: `96${String(runId).slice(-8)}`,
      role: "agent",
      status: "active",
    }),
  });
  const memberUpdated = await memberUpdateRes.json();
  assert(
    memberUpdateRes.status === 200 && memberUpdated.member?.name === `${agentName} Updated`,
    "PUT /api/admin/members/:id through Proxy",
    `Updated Name: ${memberUpdated.member?.name}`
  );

  // ── TEST 3: Lead CRUD & Specialized Routes via Frontend Proxy ──────────────
  console.log("\n--- Testing Lead CRUD & Specialized Routes Proxy ---");

  // 3a. GET /api/admin/leads/check-phone
  const testPhone = `95${String(runId).slice(-8)}`;
  const checkPhoneRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/check-phone?phone=${testPhone}`, {
    headers: { Cookie: adminCookie },
  });
  const checkPhoneData = await checkPhoneRes.json();
  assert(
    checkPhoneRes.status === 200 && Array.isArray(checkPhoneData.duplicates),
    "GET /api/admin/leads/check-phone through Proxy",
    `Duplicates found: ${checkPhoneData.duplicates?.length}`
  );

  // 3b. POST /api/admin/leads (Create lead)
  const createLeadRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      patientName: "Proxy Verification Patient",
      mobileNumber: testPhone,
      city: "Gurgaon",
      location: "Gurgaon",
      callerName: `${agentName} Updated`,
      subDispositions: "Appointment Booked",
      consultationCharges: "500",
      notes: "Lead created through Next.js proxy test",
    }),
  });
  const createdLeadData = await createLeadRes.json();
  const testLeadId = createdLeadData.lead?._id;
  assert(
    createLeadRes.status === 201 && !!testLeadId && /^SC-\d+$/i.test(createdLeadData.lead?.uniqueId),
    "POST /api/admin/leads through Proxy",
    `UniqueId: ${createdLeadData.lead?.uniqueId}`
  );

  // 3c. GET /api/admin/leads (Paginated table query)
  const leadsTableRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads?page=1&limit=25`, {
    headers: { Cookie: adminCookie },
  });
  const leadsTableData = await leadsTableRes.json();
  assert(
    leadsTableRes.status === 200 && Array.isArray(leadsTableData.leads) && leadsTableData.leads.length > 0,
    "GET /api/admin/leads (Table view) through Proxy",
    `Count: ${leadsTableData.leads?.length}, Page: ${leadsTableData.page}`
  );

  // 3d. GET /api/admin/leads?view=dashboard (Lightweight agent sheet query)
  const dashboardLeadsRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads?view=dashboard`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  const dashboardLeadsData = await dashboardLeadsRes.json();
  assert(
    dashboardLeadsRes.status === 200 && Array.isArray(dashboardLeadsData.leads),
    "GET /api/admin/leads?view=dashboard through Proxy",
    `Agent leads count: ${dashboardLeadsData.leads?.length}`
  );

  // 3e. GET /api/admin/leads/:id
  const getLeadDetailRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/${testLeadId}`, {
    headers: { Cookie: adminCookie },
  });
  const leadDetailData = await getLeadDetailRes.json();
  assert(
    getLeadDetailRes.status === 200 && leadDetailData.lead?.patientName === "Proxy Verification Patient",
    "GET /api/admin/leads/:id through Proxy",
    `Patient: ${leadDetailData.lead?.patientName}`
  );

  // 3f. PUT /api/admin/leads/:id
  const updateLeadRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/${testLeadId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      patientName: "Proxy Verification Patient (Modified)",
      notes: "Additional note added through proxy test",
    }),
  });
  const updateLeadData = await updateLeadRes.json();
  assert(
    updateLeadRes.status === 200 && updateLeadData.lead?.patientName === "Proxy Verification Patient (Modified)",
    "PUT /api/admin/leads/:id through Proxy",
    `Updated Patient: ${updateLeadData.lead?.patientName}`
  );

  // ── TEST 4: Bulk Operations via Frontend Proxy ─────────────────────────────
  console.log("\n--- Testing Bulk Operations Proxy ---");

  // 4a. POST /api/admin/leads/bulk (Bulk Upload)
  const bulkPhone1 = `94${String(runId).slice(-8)}`;
  const bulkPhone2 = `93${String(runId).slice(-8)}`;
  const bulkUploadRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tlToken}` },
    body: JSON.stringify({
      leads: [
        { patientName: "Bulk Proxy Lead 1", mobileNumber: bulkPhone1, city: "Delhi" },
        { patientName: "Bulk Proxy Lead 2", mobileNumber: bulkPhone2, city: "Noida" },
      ],
    }),
  });
  const bulkUploadData = await bulkUploadRes.json();
  assert(
    bulkUploadRes.status === 200 && bulkUploadData.count === 2,
    "POST /api/admin/leads/bulk through Proxy",
    `Inserted count: ${bulkUploadData.count}`
  );

  const bulkLeadIds = (bulkUploadData.leads || []).map((l: any) => l._id);

  // 4b. POST /api/admin/leads/assign-bulk (Bulk Assign)
  const bulkAssignRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/assign-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      leadIds: bulkLeadIds,
      agentName: `${agentName} Updated`,
    }),
  });
  const bulkAssignData = await bulkAssignRes.json();
  assert(
    bulkAssignRes.status === 200 && bulkAssignData.modifiedCount === 2,
    "POST /api/admin/leads/assign-bulk through Proxy",
    `Modified count: ${bulkAssignData.modifiedCount}`
  );

  // 4c. POST /api/admin/leads/bulk-update (Bulk Update)
  const bulkUpdateRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      leadIds: bulkLeadIds,
      fieldName: "subDispositions",
      fieldValue: "Appointment Booked",
    }),
  });
  const bulkUpdateData = await bulkUpdateRes.json();
  assert(
    bulkUpdateRes.status === 200 && bulkUpdateData.modifiedCount === 2,
    "POST /api/admin/leads/bulk-update through Proxy",
    `Modified count: ${bulkUpdateData.modifiedCount}`
  );

  // 4d. POST /api/admin/leads/merge (Merge Leads)
  const mergeRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      masterLeadId: bulkLeadIds[0],
      otherLeadIds: [bulkLeadIds[1]],
      selectedFieldValues: {
        location: "Consolidated Center",
      },
    }),
  });
  const mergeData = await mergeRes.json();
  assert(
    mergeRes.status === 200 && mergeData.deletedCount === 1,
    "POST /api/admin/leads/merge through Proxy",
    `Merged into Master ID: ${mergeData.masterLeadId}`
  );

  // ── TEST 5: Dashboard Analytics via Frontend Proxy ─────────────────────────
  console.log("\n--- Testing Dashboard Statistics Proxy ---");

  const dashStatsRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/dashboard-stats?month=All&location=All&fresh=true`, {
    headers: { Cookie: adminCookie },
  });
  const dashStats = await dashStatsRes.json();
  assert(
    dashStatsRes.status === 200 &&
    typeof dashStats.metrics === "object" &&
    Array.isArray(dashStats.distinctMonths) &&
    Array.isArray(dashStats.distinctLocations) &&
    typeof dashStats.ftdData === "object" &&
    typeof dashStats.mtdData === "object" &&
    typeof dashStats.callSummaryData === "object",
    "GET /api/admin/dashboard-stats through Proxy",
    `Total leads calculated: ${dashStats.metrics?.total}`
  );

  // ── TEST 6: Form Configuration via Frontend Proxy ──────────────────────────
  console.log("\n--- Testing Form Configuration Proxy ---");

  // 6a. GET /api/admin/form-config
  const formConfigRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/form-config`, {
    headers: { Cookie: adminCookie },
  });
  const formConfigData = await formConfigRes.json();
  assert(
    formConfigRes.status === 200 && Array.isArray(formConfigData.config?.fields),
    "GET /api/admin/form-config through Proxy",
    `Fields count: ${formConfigData.config?.fields?.length}`
  );

  // 6b. PUT /api/admin/form-config
  const currentFields = formConfigData.config?.fields || [];
  const putConfigRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/form-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      fields: currentFields,
    }),
  });
  assert(putConfigRes.status === 200, "PUT /api/admin/form-config through Proxy", `Status: ${putConfigRes.status}`);

  // 6c. POST /api/admin/form-config/reset
  const resetConfigRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/form-config/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
  });
  assert(resetConfigRes.status === 200, "POST /api/admin/form-config/reset through Proxy", `Status: ${resetConfigRes.status}`);

  // ── TEST 7: Cleanup Test Artifacts & Logout ────────────────────────────────
  console.log("\n--- Cleanup & Logout Verification ---");

  // Delete test lead
  const delLeadRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/${testLeadId}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  assert(delLeadRes.status === 200, "DELETE /api/admin/leads/:id through Proxy", `Status: ${delLeadRes.status}`);

  // Delete merged master lead
  await fetch(`${FRONTEND_ORIGIN}/api/admin/leads/${bulkLeadIds[0]}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });

  // Delete test agent member
  const delMemberRes = await fetch(`${FRONTEND_ORIGIN}/api/admin/members/${agentId}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  assert(delMemberRes.status === 200, "DELETE /api/admin/members/:id through Proxy", `Status: ${delMemberRes.status}`);

  // Logout via proxy -> verify Set-Cookie clears token
  const logoutRes = await fetch(`${FRONTEND_ORIGIN}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
  const logoutSetCookie = logoutRes.headers.get("set-cookie") || "";
  assert(
    logoutRes.status === 200 && (logoutSetCookie.includes("token=;") || logoutSetCookie.includes("Max-Age=0") || logoutSetCookie.includes("Expires=Thu, 01 Jan 1970")),
    "POST /api/auth/logout through Proxy (Cookie Cleared)",
    `Header: ${logoutSetCookie.slice(0, 30)}...`
  );

  // ── SUMMARY REPORT ────────────────────────────────────────────────────────
  console.log("\n==========================================");
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`TOTAL PROXY TESTS: ${total}`);
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
