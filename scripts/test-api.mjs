const response = await fetch("http://127.0.0.1:3000/api/analyze", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "taxlab_partner_2026",
  },
  body: JSON.stringify({
    query: "소득세법",
    tool: "search_law",
  }),
});

const data = await response.json();
console.log("Analyze API Status:", response.status);
console.log("Quality Gate:", data.quality_gate);
console.log("Result Tool:", data.data?.tool);
console.log("Search Results Preview:", data.data?.result?.content?.[0]?.text?.slice(0, 300));
