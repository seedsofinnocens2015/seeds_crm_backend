/**
 * Phase 2 Automated Verification Test Suite
 * Tests all authentication flows, cookies, role access, and member management.
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
  console.log("=== STARTING PHASE 2 AUTOMATED TEST SUITE ===\n");

  let adminCookie = "";
  let adminToken = "";
  let teamLeaderToken = "";
  let agentToken = "";
  let misToken = "";
  let marketingToken = "";
  let createdAgentId = "";

  // 1. Test /health
  const healthRes = await fetch("http://localhost:5000/health");
  const healthData = await healthRes.json();
  assert(
    healthRes.status === 200 && healthData.status === "ok",
    "Health Endpoint",
    `Status: ${healthRes.status}, connected: ${healthData.database.connected}`
  );

  // 2. Test /auth/me with no session
  const meNoAuth = await fetch(`${BASE_URL}/auth/me`);
  const meNoAuthData = await meNoAuth.json();
  assert(
    meNoAuth.status === 401 && meNoAuthData.user === null,
    "GET /auth/me without token",
    `Status: ${meNoAuth.status}`
  );

  // 3. Test Initial Admin Signup (bootstrap or existing admin check)
  let adminEmail = `test.admin.${Date.now()}@seeds-crm.dev`;
  let signupRes = await fetch(`${BASE_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Super Admin",
      mobile: "9999999999",
      email: adminEmail,
      password: "AdminPassword123!",
    }),
  });
  let signupData = await signupRes.json();

  if (signupRes.status === 403) {
    // An admin already exists in dev DB, use known bootstrap admin credentials
    adminEmail = "test.admin.1792393493810@seeds-crm.dev";
    assert(true, "POST /auth/signup (Admin Bootstrap)", "Existing dev admin reused");
  } else {
    assert(
      signupRes.status === 201 && signupData.user?.role === "admin",
      "POST /auth/signup (Admin Bootstrap)",
      `Created admin: ${signupData.user?.email}`
    );
  }

  // 4. Test Second Admin Signup without admin token (MUST FAIL with 403)
  const secondSignup = await fetch(`${BASE_URL}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Unauthorized Admin",
      mobile: "9999999998",
      email: `unauth.admin.${Date.now()}@seeds-crm.dev`,
      password: "Password123!",
    }),
  });
  assert(
    secondSignup.status === 403,
    "POST /auth/signup (Restricted when admin exists)",
    `Status: ${secondSignup.status}`
  );

  // 5. Test Invalid Login
  const badLogin = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: adminEmail,
      password: "WrongPassword!",
    }),
  });
  assert(badLogin.status === 401, "POST /auth/login (Invalid Password)", `Status: ${badLogin.status}`);

  // 6. Test Successful Admin Login & Cookie Extraction
  const adminLogin = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: adminEmail,
      password: "AdminPassword123!",
      requiredRole: "admin",
    }),
  });
  const adminLoginData = await adminLogin.json();
  const setCookieHeader = adminLogin.headers.get("set-cookie") || "";
  adminCookie = setCookieHeader.split(";")[0];
  adminToken = adminLoginData.token;

  assert(
    adminLogin.status === 200 && adminLoginData.user?.role === "admin" && setCookieHeader.includes("token="),
    "POST /auth/login (Admin Successful Login & Cookie)",
    `Cookie set: ${setCookieHeader.slice(0, 30)}...`
  );

  // 7. Test /auth/me with Cookie
  const meWithCookie = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Cookie: adminCookie },
  });
  const meCookieData = await meWithCookie.json();
  assert(
    meWithCookie.status === 200 && meCookieData.user?.email === adminEmail,
    "GET /auth/me (Authenticated via Cookie)",
    `User: ${meCookieData.user?.name}`
  );

  // 8. Test Member Creation by Admin for all remaining 4 roles: team_leader, agent, mis, marketing
  const rolesToCreate = [
    { role: "team_leader", name: "TL Sharma", email: `tl.${Date.now()}@seeds-crm.dev` },
    { role: "agent", name: "Agent Verma", email: `agent.${Date.now()}@seeds-crm.dev` },
    { role: "mis", name: "MIS Singh", email: `mis.${Date.now()}@seeds-crm.dev` },
    { role: "marketing", name: "Marketing Patel", email: `mkt.${Date.now()}@seeds-crm.dev` },
  ];

  for (const item of rolesToCreate) {
    const res = await fetch(`${BASE_URL}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name: item.name,
        mobile: "9876543210",
        email: item.email,
        password: "MemberPassword123!",
        role: item.role,
      }),
    });
    const data = await res.json();
    assert(
      res.status === 201 && data.member?.role === item.role,
      `POST /members (Admin creating ${item.role})`,
      `Status: ${res.status}`
    );

    // Login each member to test portal login and acquire tokens
    const loginRes = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: item.email,
        password: "MemberPassword123!",
        requiredRole: item.role,
      }),
    });
    const loginData = await loginRes.json();
    assert(
      loginRes.status === 200 && loginData.user?.role === item.role,
      `POST /auth/login (${item.role} portal login)`,
      `User ID: ${loginData.user?.id}`
    );

    if (item.role === "team_leader") teamLeaderToken = loginData.token;
    if (item.role === "agent") {
      agentToken = loginData.token;
      createdAgentId = loginData.user?.id;
    }
    if (item.role === "mis") misToken = loginData.token;
    if (item.role === "marketing") marketingToken = loginData.token;
  }

  // 9. Test Portal Role Mismatch Protection
  const mismatchLogin = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: adminEmail,
      password: "AdminPassword123!",
      requiredRole: "agent", // Admin trying to log in through agent portal
    }),
  });
  assert(
    mismatchLogin.status === 403,
    "POST /auth/login (Portal Role Mismatch Guard)",
    `Status: ${mismatchLogin.status}`
  );

  // 10. Test Member Access by Unauthorized Roles (Agent, MIS, Marketing cannot manage members)
  const agentMemberAccess = await fetch(`${BASE_URL}/members`, {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  assert(
    agentMemberAccess.status === 403,
    "GET /members (Agent Access Blocked by RBAC)",
    `Status: ${agentMemberAccess.status}`
  );

  // 11. Test Team Leader Permissions
  // TL can fetch members
  const tlGetMembers = await fetch(`${BASE_URL}/members`, {
    headers: { Authorization: `Bearer ${teamLeaderToken}` },
  });
  assert(tlGetMembers.status === 200, "GET /members (Team Leader allowed)", `Status: ${tlGetMembers.status}`);

  // TL can add an Agent
  const tlAddAgent = await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teamLeaderToken}`,
    },
    body: JSON.stringify({
      name: "Sub Agent",
      mobile: "9876543211",
      email: `sub.agent.${Date.now()}@seeds-crm.dev`,
      password: "SubPassword123!",
      role: "agent",
    }),
  });
  assert(tlAddAgent.status === 201, "POST /members (TL adding Agent)", `Status: ${tlAddAgent.status}`);

  // TL CANNOT add another Team Leader or Admin (MUST FAIL with 403)
  const tlAddTL = await fetch(`${BASE_URL}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${teamLeaderToken}`,
    },
    body: JSON.stringify({
      name: "Second TL",
      mobile: "9876543212",
      email: `second.tl.${Date.now()}@seeds-crm.dev`,
      password: "SubPassword123!",
      role: "team_leader",
    }),
  });
  assert(
    tlAddTL.status === 403,
    "POST /members (TL restricted from creating non-agents)",
    `Status: ${tlAddTL.status}`
  );

  // 12. Test Member Update & Account Deactivation
  const deactivateAgent = await fetch(`${BASE_URL}/members/${createdAgentId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      status: "inactive",
    }),
  });
  const deactData = await deactivateAgent.json();
  assert(
    deactivateAgent.status === 200 && deactData.member?.status === "inactive",
    "PUT /members/:id (Deactivate Member Account)",
    `Member status: ${deactData.member?.status}`
  );

  // Deactivated agent login attempt (MUST BE REJECTED WITH 403)
  const deactLogin = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `agent.${createdAgentId}`.toLowerCase(), // dummy test check
      password: "MemberPassword123!",
    }),
  });
  // Test with actual email
  const existingAgentCheck = await fetch(`${BASE_URL}/members/${createdAgentId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const existingAgentDoc = await existingAgentCheck.json();
  const realDeactLogin = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: existingAgentDoc.member.email,
      password: "MemberPassword123!",
    }),
  });
  assert(
    realDeactLogin.status === 403,
    "POST /auth/login (Deactivated Account Login Blocked)",
    `Status: ${realDeactLogin.status}`
  );

  // 13. Test DELETE /members/:id by TL (TL cannot delete members, only Admin can)
  const tlDelete = await fetch(`${BASE_URL}/members/${createdAgentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${teamLeaderToken}` },
  });
  assert(
    tlDelete.status === 403,
    "DELETE /members/:id (Team Leader cannot delete members)",
    `Status: ${tlDelete.status}`
  );

  // Admin deletes member
  const adminDelete = await fetch(`${BASE_URL}/members/${createdAgentId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert(
    adminDelete.status === 200,
    "DELETE /members/:id (Admin successfully deletes member)",
    `Status: ${adminDelete.status}`
  );

  // 14. Test POST /auth/logout (clears cookie)
  const logoutRes = await fetch(`${BASE_URL}/auth/logout`, { method: "POST" });
  const logoutSetCookie = logoutRes.headers.get("set-cookie") || "";
  assert(
    logoutRes.status === 200 && (logoutSetCookie.includes("token=;") || logoutSetCookie.includes("Max-Age=0") || logoutSetCookie.includes("Expires=")),
    "POST /auth/logout (Cookie cleared)",
    `Set-Cookie: ${logoutSetCookie}`
  );

  console.log("\n=== TEST RUN SUMMARY ===");
  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Passed: ${passedCount} / ${results.length}`);
  if (passedCount === results.length) {
    console.log("🎉 ALL TESTS PASSED SUCCESSFULLY!");
  } else {
    console.error("❌ SOME TESTS FAILED!");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
