/**
 * Phase 3 Automated Verification Test Suite
 * Tests Lead CRUD, Phone Duplicate Checking, Role-based Lead Scoping,
 * Agent Field Protection, Mandatory Notes/Sub-disposition, and Form Config.
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
  console.log("=== STARTING PHASE 3 AUTOMATED TEST SUITE ===\n");

  let adminToken = "";
  let teamLeaderToken = "";
  let agent1Token = "";
  let agent2Token = "";
  const agent1Name = "Agent One";
  const agent2Name = "Agent Two";

  // 1. Authenticate Admin and create test Team Leader & Agents
  // Check if we can login with the known bootstrap admin or register a new one
  const existingAdminEmail = "test.admin.1792393493810@seeds-crm.dev";
  let adminLogin = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: existingAdminEmail, password: "AdminPassword123!" }),
  });

  if (!adminLogin.ok) {
    const freshAdminEmail = `phase3.admin.${Date.now()}@seeds-crm.dev`;
    await fetch(`${BASE_URL}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Phase 3 Admin",
        mobile: "9876543200",
        email: freshAdminEmail,
        password: "AdminPassword123!",
      }),
    });
    adminLogin = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: freshAdminEmail, password: "AdminPassword123!" }),
    });
  }

  const adminLoginData = await adminLogin.json();
  adminToken = adminLoginData.token;

  // Create TL, Agent 1, Agent 2
  const agent1Email = `agent1.${Date.now()}@seeds-crm.dev`;
  const agent2Email = `agent2.${Date.now()}@seeds-crm.dev`;
  const tlEmail = `tl.${Date.now()}@seeds-crm.dev`;

  await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: "Team Leader One", mobile: "9876543201", email: tlEmail, password: "Password123!", role: "team_leader" }),
  });
  await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: agent1Name, mobile: "9876543202", email: agent1Email, password: "Password123!", role: "agent" }),
  });
  await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: agent2Name, mobile: "9876543203", email: agent2Email, password: "Password123!", role: "agent" }),
  });

  const tlLogin = await (await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: tlEmail, password: "Password123!" }),
  })).json();
  teamLeaderToken = tlLogin.token;

  const a1Login = await (await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: agent1Email, password: "Password123!" }),
  })).json();
  agent1Token = a1Login.token;

  const a2Login = await (await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: agent2Email, password: "Password123!" }),
  })).json();
  agent2Token = a2Login.token;

  assert(!!adminToken && !!teamLeaderToken && !!agent1Token && !!agent2Token, "Auth Setup", "All test roles generated");

  // 2. Create Lead as Admin assigned to Agent 1
  const testPhone = "9812345678";
  const createLeadRes = await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Ramesh Kumar",
      mobileNumber: testPhone,
      callerName: agent1Name,
      subDispositions: "Appointment Booked",
      notes: "Initial consultation scheduled for next week",
      location: "Gurgaon",
    }),
  });
  const createLeadData = await createLeadRes.json();
  const createdLeadId = createLeadData.lead?._id;
  const createdLeadUniqueId = createLeadData.lead?.uniqueId;

  assert(
    createLeadRes.status === 201 &&
    createLeadData.lead?.patientName === "Ramesh Kumar" &&
    createLeadData.lead?.dispositions === "Converted" && // auto-cascaded
    createLeadData.lead?.validStatus === "Valid" && // auto-cascaded
    createLeadData.lead?.notesHistory?.length === 1 &&
    createLeadData.lead?.notes === "", // reset
    "POST /leads (Creation with sub-disposition auto-cascade & notesHistory)",
    `Lead: ${createdLeadUniqueId}`
  );

  // 3. Create Lead assigned to Agent 2
  const leadAgent2Res = await fetch(`${BASE_URL}/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      patientName: "Suresh Sharma",
      mobileNumber: "9823456789",
      callerName: agent2Name,
      subDispositions: "Busy",
      location: "Delhi MN",
    }),
  });
  const leadAgent2Data = await leadAgent2Res.json();
  const lead2UniqueId = leadAgent2Data.lead?.uniqueId;

  // 4. Test Lead Listing & Agent Scoping (GET /leads)
  // Admin sees both leads
  const adminLeadsRes = await (await fetch(`${BASE_URL}/leads`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(
    adminLeadsRes.totalCount >= 2,
    "GET /leads (Admin sees all leads)",
    `Count: ${adminLeadsRes.totalCount}`
  );

  // Agent 1 sees only their lead
  const agent1LeadsRes = await (await fetch(`${BASE_URL}/leads`, {
    headers: { Authorization: `Bearer ${agent1Token}` },
  })).json();
  const agent1OnlyOwn = agent1LeadsRes.leads.every((l: any) => l.callerName.toLowerCase() === agent1Name.toLowerCase());
  assert(
    agent1OnlyOwn && agent1LeadsRes.leads.some((l: any) => l.uniqueId === createdLeadUniqueId),
    "GET /leads (Agent 1 scoped strictly to assigned leads)",
    `Agent 1 count: ${agent1LeadsRes.totalCount}`
  );

  // 5. Single Lead Access Scoping (GET /leads/:id)
  // Agent 1 can view their lead
  const agent1ViewOwn = await fetch(`${BASE_URL}/leads/${createdLeadUniqueId}`, {
    headers: { Authorization: `Bearer ${agent1Token}` },
  });
  assert(agent1ViewOwn.status === 200, "GET /leads/:id (Agent 1 views assigned lead)", `Status: 200`);

  // Agent 2 CANNOT view Agent 1's lead (MUST FAIL with 403)
  const agent2ViewOther = await fetch(`${BASE_URL}/leads/${createdLeadUniqueId}`, {
    headers: { Authorization: `Bearer ${agent2Token}` },
  });
  assert(agent2ViewOther.status === 403, "GET /leads/:id (Agent 2 blocked from Agent 1's lead)", `Status: ${agent2ViewOther.status}`);

  // 6. Test Agent Update Protections (PUT /leads/:id)
  // Agent 1 attempts to change protected Section 1 fields (mobileNumber, callerName, date)
  const agentTamperRes = await fetch(`${BASE_URL}/leads/${createdLeadUniqueId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent1Token}` },
    body: JSON.stringify({
      mobileNumber: "9111111111", // Tampered
      callerName: agent2Name, // Tampered
      subDispositions: "Appointment Booked",
      notes: "Agent update note",
    }),
  });
  const agentTamperData = await agentTamperRes.json();
  assert(
    agentTamperRes.status === 200 &&
    agentTamperData.lead?.mobileNumber === testPhone && // Preserved original
    agentTamperData.lead?.callerName === agent1Name, // Preserved original
    "PUT /leads/:id (Agent field protection: system fields immutable)",
    `Phone retained: ${agentTamperData.lead?.mobileNumber}`
  );

  // Agent must provide both notes and sub-dispositions
  const agentMissingNotes = await fetch(`${BASE_URL}/leads/${createdLeadUniqueId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent1Token}` },
    body: JSON.stringify({
      subDispositions: "Ringing",
      notes: "", // Missing
    }),
  });
  assert(agentMissingNotes.status === 400, "PUT /leads/:id (Agent mandatory notes requirement)", `Status: ${agentMissingNotes.status}`);

  // 7. Duplicate Phone Check (GET /leads/check-phone)
  // Normalization test with spaces and dashes
  const phoneCheck1 = await (await fetch(`${BASE_URL}/leads/check-phone?phone=9812-34-5678`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(
    phoneCheck1.duplicates.length > 0 && phoneCheck1.duplicates[0].uniqueId === createdLeadUniqueId,
    "GET /leads/check-phone (Normalized duplicate match)",
    `Found match: ${phoneCheck1.duplicates[0].uniqueId}`
  );

  // Less than 4 digits returns empty array immediately
  const phoneShort = await (await fetch(`${BASE_URL}/leads/check-phone?phone=98`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(phoneShort.duplicates.length === 0, "GET /leads/check-phone (Short string < 4 digits)", `Duplicates: 0`);

  // 8. Delete Lead Permission Check (DELETE /leads/:id)
  // Agent CANNOT delete lead (MUST FAIL with 403)
  const agentDelete = await fetch(`${BASE_URL}/leads/${createdLeadUniqueId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${agent1Token}` },
  });
  assert(agentDelete.status === 403, "DELETE /leads/:id (Agent forbidden from deleting leads)", `Status: ${agentDelete.status}`);

  // Admin deletes lead
  const adminDelete = await fetch(`${BASE_URL}/leads/${createdLeadUniqueId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(adminDelete.status === 200, "DELETE /leads/:id (Admin successfully deletes lead)", `Status: ${adminDelete.status}`);

  // 9. Form Configuration Endpoints (GET, PUT, POST /reset)
  // Fetch default form config
  const formConfigRes = await (await fetch(`${BASE_URL}/form-config`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })).json();
  assert(
    formConfigRes.config?.sections?.length === 4 && formConfigRes.config?.fields?.length > 0,
    "GET /form-config (Retrieves 4 sections and default fields)",
    `Fields count: ${formConfigRes.config?.fields?.length}`
  );

  // Agent cannot edit form config
  const agentEditConfig = await fetch(`${BASE_URL}/form-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agent1Token}` },
    body: JSON.stringify({ fields: [] }),
  });
  assert(agentEditConfig.status === 403, "PUT /form-config (Agent forbidden from updating form-config)", `Status: ${agentEditConfig.status}`);

  // Team Leader can update form config
  const tlUpdateConfig = await fetch(`${BASE_URL}/form-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${teamLeaderToken}` },
    body: JSON.stringify({
      fields: formConfigRes.config.fields,
      sections: formConfigRes.config.sections,
      subDispositionMappings: formConfigRes.config.subDispositionMappings,
    }),
  });
  assert(tlUpdateConfig.status === 200, "PUT /form-config (Team Leader allowed to update form-config)", `Status: ${tlUpdateConfig.status}`);

  // Reset form config
  const resetConfig = await fetch(`${BASE_URL}/form-config/reset`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(resetConfig.status === 200, "POST /form-config/reset (Admin resets to default)", `Status: ${resetConfig.status}`);

  console.log("\n=== TEST RUN SUMMARY ===");
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Passed: ${passedCount} / ${results.length}`);
  if (passedCount === results.length) {
    console.log("🎉 ALL PHASE 3 TESTS PASSED SUCCESSFULLY!");
  } else {
    console.error("❌ SOME TESTS FAILED!");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
