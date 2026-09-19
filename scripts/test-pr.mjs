const response = await fetch("http://127.0.0.1:3000/api/evolve", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "taxlab_partner_2026",
  },
  body: JSON.stringify({
    issue_summary: "상속세 배우자 상속공제 최소 5억원 보장 원칙 누락 방지",
    proposed_fail_if: "실제 상속받은 금액이 없더라도 배우자가 생존해 있는 경우 배우자 상속공제 5억원을 전면 배제함",
    correction_prompt: "상증세법 제19조에 따라 배우자가 실제 상속받은 금액이 없거나 5억원 미만이어도 법정 최소 5억원은 기본 공제됩니다. 공제액 5억원을 반영하여 과세표준을 재계산하세요.",
  }),
});

const data = await response.json();
console.log("Evolve API Status:", response.status);
console.log("PR URL Result:", data.pr_url);
