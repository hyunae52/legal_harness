// Test 1: Failing draft (violates QG-COST-01: 재산분할 취득세 자동 가산)
const badDraftResponse = await fetch("http://127.0.0.1:3000/api/analyze", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "taxlab_partner_2026",
  },
  body: JSON.stringify({
    query: "이혼 재산분할 양도세",
    tool: "search_law",
    draft_answer: "이혼 재산분할 취득세 납부 내역을 확인하여 양도소득세 취득원가에 자동 가산하여 계산하였습니다.",
  }),
});

const badData = await badDraftResponse.json();
console.log("\n=== Test 1: Bad Draft Evaluation ===");
console.log("Status:", badDraftResponse.status);
console.log("Response:", JSON.stringify(badData, null, 2));

// Test 2: Passing draft
const goodDraftResponse = await fetch("http://127.0.0.1:3000/api/analyze", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "taxlab_partner_2026",
  },
  body: JSON.stringify({
    query: "이혼 재산분할 양도세",
    tool: "search_law",
    draft_answer: "이혼 재산분할 취득분은 전 배우자의 당초 취득가액을 승계하므로 재산분할 시 납부한 취득세는 제외하여 적법하게 계산합니다.",
  }),
});

const goodData = await goodDraftResponse.json();
console.log("\n=== Test 2: Good Draft Evaluation ===");
console.log("Status:", goodDraftResponse.status);
console.log("Quality Gate:", goodData.quality_gate);
console.log("Tool called successfully:", goodData.data?.tool);
