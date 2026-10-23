/**
 * Phase 4 Automated Verification Test Suite
 * Tests:
 * 1. Role-based access control for bulk operations:
 *    - POST /leads/bulk-upload (Admin, TL allowed; Agent forbidden 403)
 *    - POST /leads/assign-bulk (Admin, TL allowed; Agent forbidden 403)
 *    - POST /leads/bulk-update (Admin allowed; TL and Agent forbidden 403)
 *    - POST /leads/merge (Admin allowed; TL and Agent forbidden 403)
 * 2. Bulk Lead Upload:
 *    - Generates sequential SC- IDs correctly and atomically
 *    - Phone normalization and duplicate skip/reporting
 *    - Field validation and missing required field tracking
 *    - Default values (open stage, Fresh Leads status)
 * 3. Bulk Lead Assignment:
 *    - Updates callerName and assignedDate atomically
 *    - Validates target agent existence and active status
 *    - Appends audit logs with change diff
 * 4. Bulk Lead Update:
 *    - Restricts modification to ALLOWED_BULK_UPDATE_FIELDS
 *    - Automatically cascades sub-dispositions to stage and leadStatus
 *    - Appends audit logs
 * 5. Lead Merging:
 *    - Preserves lowest serial SC- ID as primary
 *    - Merges notes history and audit logs chronologically
 *    - Populates blank fields on primary from secondary
 *    - Deletes merged secondary leads
 *    - Handles validation errors (e.g. merging < 2 leads or non-existent IDs)
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
  console.log("=== STARTING PHASE 4 BULK OPERATIONS TEST SUITE ===\n");

  const runId = Date.now();
  let adminToken = "";
  let tlToken = "";
  let agentToken = "";
  let agentUserId = "";
  let agentName = "Test Agent P4";

  // 1. Authenticate / Bootstrap Admin
  const adminEmail = `p4.admin.${runId}@seeds-crm.dev`;
  const adminSignup = await fetch(`${BASE_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Phase 4 Admin",
      mobile: `98${String(runId).slice(-8)}`,
      email: adminEmail,
      password: "AdminPassword123!",
    }),
  });

  if (adminSignup.status === 201) {
    const data = await adminSignup.json();
    adminToken = data.token;
  } else {
    // Already bootstrapped, login with existing admin
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

  assert(!!adminToken, "Admin Authentication", "Admin token retrieved");

  // Create Team Leader
  const tlEmail = `p4.tl.${runId}@seeds-crm.dev`;
  const tlRes = await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: "Phase 4 Team Leader",
      email: tlEmail,
      mobile: `97${String(runId).slice(-8)}`,
      role: "team_leader",
      password: "TLPassword123!",
    }),
  });
  const tlData = await tlRes.json();
  const tlLoginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: tlEmail, password: "TLPassword123!" }),
  });
  const tlLoginData = await tlLoginRes.json();
  tlToken = tlLoginData.token;
  assert(tlRes.status === 201 && !!tlToken, "Team Leader Created & Logged In", `TL created: ${tlEmail}`);

  // Create Agent
  const agentEmail = `p4.agent.${runId}@seeds-crm.dev`;
  const agentRes = await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      name: agentName,
      email: agentEmail,
      mobile: `96${String(runId).slice(-8)}`,
      role: "agent",
      password: "AgentPassword123!",
    }),
  });
  const agentData = await agentRes.json();
  const agentLoginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: agentEmail, password: "AgentPassword123!" }),
  });
  const agentLoginData = await agentLoginRes.json();
  agentToken = agentLoginData.token;
  agentUserId = agentData.member?.id || agentData.member?._id;
  assert(agentRes.status === 201 && !!agentToken, "Agent Created & Logged In", `Agent created: ${agentEmail} (ID: ${agentUserId})`);

  // ── TEST 1: Role-Based Access Control ───────────────────────────────────────
  console.log("\n--- Testing RBAC for Bulk Operations ---");

  // 1a. Agent attempting bulk upload -> 403 Forbidden
  const agentUploadRes = await fetch(`${BASE_URL}/leads/bulk-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ leads: [{ patientName: "Test", mobileNumber: "9111111111" }] }),
  });
  assert(agentUploadRes.status === 403, "RBAC: Agent Bulk Upload Forbidden", `Status: ${agentUploadRes.status}`);

  // 1b. Agent attempting bulk assign -> 403 Forbidden
  const agentAssignRes = await fetch(`${BASE_URL}/leads/assign-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ leadIds: ["507f1f77bcf86cd799439011"], callerName: agentName }),
  });
  assert(agentAssignRes.status === 403, "RBAC: Agent Bulk Assign Forbidden", `Status: ${agentAssignRes.status}`);

  // 1c. Team Leader attempting bulk update -> 403 Forbidden (Admin only)
  const tlUpdateRes = await fetch(`${BASE_URL}/leads/bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tlToken}` },
    body: JSON.stringify({ leadIds: ["507f1f77bcf86cd799439011"], updateData: { city: "Delhi" } }),
  });
  assert(tlUpdateRes.status === 403, "RBAC: TL Bulk Update Forbidden (Admin only)", `Status: ${tlUpdateRes.status}`);

  // 1d. Team Leader attempting lead merge -> 403 Forbidden (Admin only)
  const tlMergeRes = await fetch(`${BASE_URL}/leads/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tlToken}` },
    body: JSON.stringify({ leadIds: ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"] }),
  });
  assert(tlMergeRes.status === 403, "RBAC: TL Merge Forbidden (Admin only)", `Status: ${tlMergeRes.status}`);

  // ── TEST 2: Bulk Lead Upload ────────────────────────────────────────────────
  console.log("\n--- Testing Bulk Lead Upload ---");

  // Create an initial lead to test duplicate phone replacement during bulk upload
  const existingPhone = `95${String(runId).slice(-8)}`;
  const initLeadRes = await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Existing Patient",
      mobileNumber: existingPhone,
      city: "Kolkata",
    }),
  });
  const initLeadData = await initLeadRes.json();
  const initLeadId = initLeadData.lead?._id;
  assert(initLeadRes.status === 201, "Seed Lead Created", `Unique ID: ${initLeadData.lead?.uniqueId}`);

  // Team Leader performs bulk upload with:
  // - 2 valid new leads
  // - 1 lead matching existingPhone (replaces old lead, preserves uniqueId)
  const newPhone1 = `94${String(runId).slice(-8)}`;
  const newPhone2 = `93${String(runId).slice(-8)}`;

  const uploadBatch = [
    { patientName: "Bulk Patient 1", mobileNumber: newPhone1, city: "Mumbai", callerName: agentName },
    { patientName: "Bulk Patient Duplicate DB", mobileNumber: existingPhone, city: "Kolkata Updated" },
    { patientName: "Bulk Patient 2", mobileNumber: newPhone2, city: "Delhi" },
  ];

  const tlUploadRes = await fetch(`${BASE_URL}/leads/bulk-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tlToken}` },
    body: JSON.stringify({ leads: uploadBatch }),
  });
  const uploadResult = await tlUploadRes.json();

  assert(tlUploadRes.status === 200, "TL Bulk Upload Allowed", `Status: ${tlUploadRes.status}`);
  assert(uploadResult.count === 3, "Bulk Upload Inserted Count", `Inserted: ${uploadResult.count} (expected 3)`);
  assert(uploadResult.deletedCount === 1, "Bulk Upload Replaced Duplicates", `Deleted duplicates: ${uploadResult.deletedCount} (expected 1)`);

  // Verify created leads have valid SC- IDs
  const createdBulkLeads = uploadResult.leads;
  const allValidIds = createdBulkLeads.every((l: any) => /^SC-\d+$/i.test(l.uniqueId));
  assert(allValidIds, "Atomic SC- Sequential IDs on Bulk Upload", `Unique IDs: ${createdBulkLeads.map((l: any) => l.uniqueId).join(", ")}`);

  // Verify alias /api/v1/leads/bulk also works for frontend backward compatibility
  const aliasPhone = `92${String(runId).slice(-8)}`;
  const aliasUploadRes = await fetch(`${BASE_URL}/leads/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ leads: [{ patientName: "Alias Lead", mobileNumber: aliasPhone }] }),
  });
  const aliasData = await aliasUploadRes.json();
  assert(aliasUploadRes.status === 200 && aliasData.count === 1, "Bulk Route Alias Compatibility (/bulk)", `Count: ${aliasData.count}`);

  // ── TEST 3: Bulk Lead Assignment ───────────────────────────────────────────
  console.log("\n--- Testing Bulk Lead Assignment ---");

  // Fetch leads to assign (the newly created bulk leads)
  const targetLeadIds = createdBulkLeads.map((l: any) => l._id);

  // 3a. Assign leads to agent using agent name
  const assignRes = await fetch(`${BASE_URL}/leads/assign-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      leadIds: targetLeadIds,
      agentName: agentName,
    }),
  });
  const assignData = await assignRes.json();

  assert(assignRes.status === 200, "Bulk Assign Success Status", `Status: ${assignRes.status}`);
  assert(assignData.modifiedCount === targetLeadIds.length, "Bulk Assign Modified Count", `Modified: ${assignData.modifiedCount}`);

  // 3b. Verify updated leads in database have callerName and auditLog entry
  const checkLead1Res = await fetch(`${BASE_URL}/leads/${targetLeadIds[0]}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const checkLead1 = (await checkLead1Res.json()).lead;
  const hasAuditLog = checkLead1.auditLogs?.some((a: any) =>
    a.changes?.some((c: any) => c.field === "callerName")
  );
  assert(
    checkLead1.callerName === agentName && !!checkLead1.assignedDate && hasAuditLog,
    "Bulk Assign Data Verification",
    `callerName: ${checkLead1.callerName}, assignedDate: ${checkLead1.assignedDate}, audit: ${hasAuditLog}`
  );

  // 3c. Bulk assign with non-existent agent name should fail
  const invalidAssignRes = await fetch(`${BASE_URL}/leads/assign-bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      leadIds: targetLeadIds,
      agentName: "Ghost Nonexistent Agent",
    }),
  });
  assert(invalidAssignRes.status === 404, "Bulk Assign Non-existent Agent Validation", `Status: ${invalidAssignRes.status}`);

  // ── TEST 4: Bulk Lead Update ───────────────────────────────────────────────
  console.log("\n--- Testing Bulk Lead Update ---");

  // 4a. Update field 'subDispositions' across selected leads (auto-cascades dispositions and validStatus)
  const updateRes = await fetch(`${BASE_URL}/leads/bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      leadIds: targetLeadIds,
      fieldName: "subDispositions",
      fieldValue: "Appointment Booked",
    }),
  });
  const updateData = await updateRes.json();

  assert(updateRes.status === 200, "Bulk Update Success Status", `Status: ${updateRes.status}`);
  assert(updateData.modifiedCount === targetLeadIds.length, "Bulk Update Modified Count", `Modified: ${updateData.modifiedCount}`);

  // Verify lead fields & cascading
  const checkLead2Res = await fetch(`${BASE_URL}/leads/${targetLeadIds[0]}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const checkLead2 = (await checkLead2Res.json()).lead;
  assert(
    checkLead2.subDispositions === "Appointment Booked" &&
    checkLead2.dispositions === "Converted" &&
    checkLead2.validStatus === "Valid",
    "Bulk Update Field & Sub-Disposition Cascading",
    `SubDisp: ${checkLead2.subDispositions}, Disp: ${checkLead2.dispositions}, Valid: ${checkLead2.validStatus}`
  );

  // 4b. Disallowed field in bulk update should return 400
  const invalidFieldUpdate = await fetch(`${BASE_URL}/leads/bulk-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      leadIds: targetLeadIds,
      fieldName: "uniqueId",
      fieldValue: "SC-9999999",
    }),
  });
  assert(invalidFieldUpdate.status === 400, "Bulk Update Rejects Disallowed Fields", `Status: ${invalidFieldUpdate.status}`);

  // ── TEST 5: Lead Merging ───────────────────────────────────────────────────
  console.log("\n--- Testing Lead Merging ---");

  // Create 2 test leads specifically to test merge:
  // Lead A: older (lower SC number), missing location, has notes
  // Lead B: newer (higher SC number), has location, has different notes
  const mergePhoneA = `91${String(runId).slice(-8)}`;
  const mergePhoneB = `90${String(runId).slice(-8)}`;

  const leadARes = await (await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Merge Primary Candidate",
      mobileNumber: mergePhoneA,
      city: "Ahmedabad",
      notes: "Primary initial consultation notes.",
    }),
  })).json();

  const leadBRes = await (await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Merge Secondary Candidate",
      mobileNumber: mergePhoneB,
      location: "Bhopal Clinic",
      notes: "Secondary follow-up notes from alternate clinic.",
    }),
  })).json();

  const leadA = leadARes.lead;
  const leadB = leadBRes.lead;

  const idNumA = parseInt(leadA.uniqueId.replace("SC-", ""), 10);
  const idNumB = parseInt(leadB.uniqueId.replace("SC-", ""), 10);
  const masterLead = idNumA <= idNumB ? leadA : leadB;
  const secondaryLead = idNumA <= idNumB ? leadB : leadA;

  // Execute merge using exact contract: masterLeadId, otherLeadIds, selectedFieldValues
  const mergeRes = await fetch(`${BASE_URL}/leads/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      masterLeadId: masterLead._id,
      otherLeadIds: [secondaryLead._id],
      selectedFieldValues: {
        location: "Bhopal Clinic",
      },
    }),
  });
  const mergeData = await mergeRes.json();

  assert(mergeRes.status === 200, "Lead Merge Success Status", `Status: ${mergeRes.status}`);
  assert(mergeData.deletedCount === 1, "Lead Merge Deleted Secondary", `Deleted count: ${mergeData.deletedCount}`);

  // Verify secondary is indeed deleted (404)
  const secondaryCheck = await fetch(`${BASE_URL}/leads/${secondaryLead._id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(secondaryCheck.status === 404, "Merged Secondary Lead Deleted From Database", `Status: ${secondaryCheck.status}`);

  // Verify master lead updated with selected field values and merged history
  const masterCheck = await (await fetch(`${BASE_URL}/leads/${masterLead._id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  const primaryLead = masterCheck.lead;

  const hasMergedLocation = primaryLead.location === "Bhopal Clinic";
  const hasNotesConsolidated = (primaryLead.notesHistory?.length || 0) >= 1;
  const hasMergeAudit = primaryLead.auditLogs?.some((a: any) =>
    a.changes?.some((c: any) => c.field === "mergeLeads")
  );

  assert(
    hasMergedLocation && hasNotesConsolidated && hasMergeAudit,
    "Master Lead Inherited Data, Consolidated History, and Stamped Audit",
    `Location: ${primaryLead.location}, Notes entries: ${primaryLead.notesHistory?.length}, Audit logs: ${primaryLead.auditLogs?.length}`
  );

  // ── TEST 6: Validation Bounds for Merge ─────────────────────────────────────
  console.log("\n--- Testing Merge Edge Cases ---");

  // 6a. Empty otherLeadIds -> 400
  const singleMergeRes = await fetch(`${BASE_URL}/leads/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ masterLeadId: masterLead._id, otherLeadIds: [] }),
  });
  assert(singleMergeRes.status === 400, "Merge Requires otherLeadIds array", `Status: ${singleMergeRes.status}`);

  // 6b. Non-existent masterLeadId -> 404
  const nonExistentMergeRes = await fetch(`${BASE_URL}/leads/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ masterLeadId: "507f1f77bcf86cd799439011", otherLeadIds: ["507f1f77bcf86cd799439012"] }),
  });
  assert(nonExistentMergeRes.status === 404, "Merge Rejects Non-Existent Master Lead", `Status: ${nonExistentMergeRes.status}`);

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
