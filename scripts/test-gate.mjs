const BASE_URL = "http://127.0.0.1:3000";
const API_KEY = "taxlab_partner_2026";

async function postAnalyze(body) {
  const res = await fetch(`${BASE_URL}/api/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

console.log("=== False-Positive Prevention & Bypass Regression Tests ===\n");

// Test 1: Affirmative Error (Should Fail & Block with 400)
const t1 = await postAnalyze({
  query: "이혼 재산분할 양도세",
  tool: "search_law",
  draft_answer: "이혼 재산분할 취득세를 양도소득세 취득원가에 자동 가산하여 계산하였습니다.",
});
console.log("1. Affirmative Error:");
console.log(`   Expected: 400 | Actual: ${t1.status} | Blocked: ${t1.data.error === "Quality Gate Failed" ? "PASS" : "FAIL"}`);

// Test 2: Negated Statement (Should NOT Fail - False Positive Fix)
const t2 = await postAnalyze({
  query: "소득세법",
  tool: "search_law",
  draft_answer: "이혼 재산분할 취득세는 취득원가에 자동 가산되지 않으며 전 배우자의 당초 가액을 승계합니다.",
});
console.log("2. Negated Statement ('자동 가산되지 않으며'):");
console.log(`   Expected: 200 | Actual: ${t2.status} | Quality Gate Passed: ${t2.data.quality_gate?.passed ? "PASS" : "FAIL"}`);

// Test 3: Prohibition Statement (Should NOT Fail)
const t3 = await postAnalyze({
  query: "소득세법",
  tool: "search_law",
  draft_answer: "재산분할 취득세를 양도세 취득원가에 자동 가산하면 안 됩니다.",
});
console.log("3. Prohibition Statement ('자동 가산하면 안 됩니다'):");
console.log(`   Expected: 200 | Actual: ${t3.status} | Quality Gate Passed: ${t3.data.quality_gate?.passed ? "PASS" : "FAIL"}`);

// Test 4: Escape Hatch via skip_gates (Should Bypass QG-COST-01)
const t4 = await postAnalyze({
  query: "소득세법",
  tool: "search_law",
  draft_answer: "이혼 재산분할 취득세를 양도소득세 취득원가에 자동 가산하여 계산하였습니다.",
  skip_gates: ["QG-COST-01"],
});
console.log("4. Escape Hatch via skip_gates=['QG-COST-01']:");
console.log(`   Expected: 200 | Actual: ${t4.status} | Bypassed: ${t4.status === 200 ? "PASS" : "FAIL"}`);

// Test 5: Soft Warning Mode (Should return 200 with warnings instead of 400)
const t5 = await postAnalyze({
  query: "소득세법",
  tool: "search_law",
  draft_answer: "이혼 재산분할 취득세를 양도소득세 취득원가에 자동 가산하여 계산하였습니다.",
  mode: "warn",
});
console.log("5. Soft Warning Mode (mode='warn'):");
console.log(`   Expected: 200 | Actual: ${t5.status} | Warnings present: ${t5.data.quality_gate?.warnings?.length > 0 ? "PASS" : "FAIL"}`);
console.log(`   Warning ID: ${t5.data.quality_gate?.warnings?.[0]?.id}`);
