# SSS 지적 보완 구현과 검증

SSS가 제품 `e3cdac3`에 내린 [REVISE](AUTHORITY_COMPLETION_SSS_RESPONSE_2026-10-02.txt)의 두 지적을 [최소 보완 계획](../AUTHORITY_SCOPE_PROMOTION_FIX_PLAN.md)에 따라 반영했다. pilot-l의 정상 대조 실패와 23/24 결과는 그대로 보존한다.

## 구현

1. 독립 고지를 기존 쟁점에 연결하기 위해 전체 계획을 다시 쓰면, 완료한 검색까지 새 revision에서 다시 요구하던 문제가 있었다. `scope_promotions`는 기존 deferred 독립 고지의 issue_id/lifecycle만 바꾸고 검색·원문·요건 평가·채택 자료·예산·TTL을 보존한다. 소유자·revision/state·busy·만료를 검사하고 새 검수를 요구한다. 새 사실이나 실제 계획 변경은 이 경로로 처리할 수 없다.
2. 판례를 본문 대신 시점 적용이나 반론 해소에 직접 인용하면 후속 검색 채택 여부가 달라졌다. 세 위치의 인용 수집을 공유해 direct/analogy 채택, 구별 선언과 직접 인용의 모순, runner의 후속 검색을 일치시켰다. 후속 처리 경과에만 인용한 자료는 기존처럼 무한 검색을 만들지 않는다.

구조 검사는 원문 연결과 실제 검색을 확인한다. `background` 또는 경과 설명이라고 잘못 분류한 법률적 의미나, 별도 고지를 다른 쟁점에 연결한 의미적 적절성까지 증명하지 않는다. 독립 의미 검수와 실제 모델 평가는 계속 필요하다.

## 검증 근거

| 검사 | 결과 |
| --- | --- |
| 제품 수정 전 인용 위치 재현 | 시점·반론 해소 2개 RED |
| 제품 수정 전 고지 승격 재현 | 정정한 fixture에서 지원하지 않는 scope_promotions 입력으로 RED |
| 초기 관련 회귀 | 89 PASS / 1 fixture 비교 오류. 조회 응답의 일시적 job wrapper와 정규 읽기 상태를 비교한 테스트를 수정 |
| 최종 `npm run review` | **323/323 PASS**, 실패·skip 0 |
| `npm run review:package` | **9/9 PASS**, 별도 prefix에 실제 설치 |

처음 RED 로그의 고지 fixture는 원문 귀속이 먼저 거절돼 의도한 경로를 재현하지 못했다. 그 결과를 제품 결함의 RED로 계산하지 않는다. 조회 실패·부분 본문·unknown 사실·다른 쟁점·미해결 분석은 새 승격 후에도 완료되지 않는 반례 검사를 포함한다. CAS·소유자·busy·TTL·중복/다중 갱신 원자성·저장 실패·실제 MCP/REST·공개 JSON Schema를 확인했다. 새 13개 검사 외 기존 회귀도 모두 실행했다.

정확한 소스·로그·패키지 SHA는 [preflight](../evidence/authority-scope-promotion-preflight-20261002.json)에 보존했다. 패키지는 로컬 검사용이며 CI 배포 산출물이 아니다. 기존 사용자 README와 NEXT_STEPS 변경은 이 구현에 포함하지 않는다.

## 남은 출시 조건

수정본의 SSS 재검수와 별도 pilot-m 24회가 남아 있다. 원래 8개 입력×3회, gpt-5.6-sol/xhigh, 회당 1,500초와 기존 서버 조회 예산을 유지한다. 이전 실패를 새 성공으로 덮어쓰거나 정상 대조 완료 기준을 낮추지 않는다. 자동 검사 통과는 최종 법률 판단 승인이나 배포 승인이 아니다. main 병합·운영 배포는 아직 하지 않았다.
