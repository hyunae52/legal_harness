# SSS 검수 후 최소 보완 계획

기준 제품은 `e3cdac332581dba27c36d8173b05a6e25a18fcde`, 근거·실행기 보완 커밋은 `1fa386e`다. 제품 코드는 같다. pilot-l 23/24 의미 PASS, 정상 대조 2/3 완료라는 실패를 보존한다. [SSS의 완료된 독립 검수](reviews/AUTHORITY_COMPLETION_SSS_RESPONSE_2026-10-02.txt)는 **REVISE**이며 좁은 고지 승격 경로를 최소 수정 후보로 인정했다. 이 문서는 그 지적을 실행 가능한 계약으로 한정한다.

## 1. 검색 의미가 바뀌지 않는 독립 고지 승격

`update_legal_research`에 `scope_promotions: [{track_id, issue_id}]`를 추가한다. `plan`, `requirement_assessments`, `scope_promotions` 중 하나만 허용한다. 승격에는 revision/state CAS를 모두 요구한다. 현재 존재하는 `independent_notice`, `deferred`, `issue_id=null` 트랙만 기존 issue에 연결할 수 있다. 새 트랙, active 재연결, requested/dependency 승격, candidate/overflow를 포함하지 않는다.

서버가 복제한 plan의 해당 issue_id/lifecycle만 바꾼다. 질문 문구·사실 앵커·당사자·관계·차단 대상·scope mode·원래 질문·사실·날짜·쟁점은 입력 자체에 포함하지 못한다. 설명은 검수의 `scope_assessments.reason`에 쓴다. 변경을 반영해 state_version은 증가하고 last_review는 무효화한다. revision·기존 검색·원문/연결/manifest·후보 원장·필요성 평가·채택 자료·TTL·예산은 보존한다. 저장 실패는 원본 세션에 아무 영향도 주지 않아야 한다.

승격 자체는 완료 판정이 아니다. 현재 evidence/fact/analysis와 모든 검색·후속 의무를 새로 검수해야 한다. 다른 쟁점을 연결해 의미상 부적절한 제외를 선언하는 문제는 구조 검사만으로 증명할 수 없으므로 독립 의미 검수를 유지한다. 실제 plan 변경은 지금처럼 revision이 바뀌며 과거 검색을 되살리지 않는다. 이미 revision이 바뀐 실패 실행은 소급 수정하지 않는다.

## 2. 인용 위치로 후속 검색을 피하는 경로

현재 `coreEvidenceIds`는 본문 claims의 non-background 인용과 applied/analogy 선언만 반영한다. 시점 적용과 반론 해소에 실제로 직접 적용한 자료도 같은 채택 기준에 포함한다. 본문·시점·반론 해소 인용을 수집하는 한 함수로 채택 여부와 disposition 모순, 추가 검색 면제 판단을 일치시킨다. 채택 자료는 기존 review→runner 경로로 실제 후속 검색 작업을 연다.

`subsequent_review.citations`는 그 자체로 판결 경과 설명용이며, 동일 자료를 본문/시점/반론의 실제 근거 또는 applied/analogy로 쓸 때에만 추가 검색을 연다. 기존 경과 설명용 direct 인용만으로 끝없는 successor 검색을 만들지 않는다. 후속 처리 인용도 원문·권위·법령 연결 검사는 그대로 받는다. 모델이 실질적 법적 결론을 경과 설명이라고 거짓 분류하는 의미 오류는 별도 검수 대상이다. `same_rule`이라는 이유만으로 applied를 강제하지 않는다.

## 3. 고정 회귀 계약

| ID | 검증 |
| --- | --- |
| SP-01 | 완전한 검색·제공 사실·원문, 예산 0, deferred 고지만 남은 fixture에서 승격→새 검수가 전체 구조 완료. 제공자 호출 증가 0. |
| SP-02 | 검색·원문/관측 시각·필요성 평가·채택 자료·TTL·예산 불변. state/plan/snapshot/binding 변경, 기존 검수 무효. |
| SP-03 | stale revision/state·다른 actor·busy·만료 거절. 같은 요청의 재전송은 stale CAS 거절. |
| SP-04 | 없는/중복 트랙, 없는 issue, relation/lifecycle 위반, 전체 plan/요건 평가와 혼합, 질문·앵커 등 임의 필드 반입 거절. |
| SP-05 | 승격 후에도 실패 검색·부분/다른 쟁점/없는 원문·unknown fact·미해결 분석은 완료되지 않음. |
| SP-06 | 용량 초과 저장 실패 후 원본 plan/state/review/예산 불변. |
| SP-07 | 실제 plan 변경은 기존 revision 무효화 유지. MCP·REST 및 공개 Actions oneOf와 런타임 분기 일치. |
| FU-01 | 후속 후보를 시점/반론 해소에 direct/analogy로 사용하면 본문과 같은 채택/후속 의무 및 runner 작업 생성. |
| FU-02 | distinguished + 시점/반론 direct의 모순을 검출. background로만 사용하는 같은 규정의 정당한 구별은 추가 검색 없이 유한 종료 가능. |
| FU-03 | 경과 설명의 subsequent_review.citations만으로 검색 세대 증가 없음. 본문 누락·미상 권위·잘못된 검색 ID는 계속 차단. |

SP-01과 FU-01/02의 제품 수정 전 RED를 기록한다. 기존 309개+실행기 1개 검사는 이전 소스의 기준선이며, 영향받는 검사·전체 review·설치 패키지를 새 구현에서 실행한다. 고정 모델 프로토콜과 시간·조회 예산은 바꾸지 않는다. 새 제품 소스로 원래 24회 전체 평가를 별도 기록하고 과거 실패를 대체하지 않는다. SSS에는 정확한 소스와 새 검증 근거로 재검수를 요청한다. 모든 합격 조건과 병합 후 정확한 main CI·배포 검증은 별개다.
