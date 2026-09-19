# 독립 Pro 수정 계획 검수

- 요청: 수정 계획 수립 후 별도 Pro 모델 검수.
- 실행 경로: 로그인된 ChatGPT의 새 독립 대화. 제출 당시 모델 선택기에 `6 Pro` 표시 확인.
- 대화: https://chatgpt.com/c/6aae839e-ad68-83ee-8ae3-b7d489b1bd4d
- 기준 코드: `d41e4588ecd374eedf5a7a846942ce27a17bf7f5`.
- 제출 자료: [v1 계획과 코드 근거](PRO_REVIEW_PACKET_2026-09-19_v1.md).
- 제출 자료 SHA-256: `7f98f0f989d63c102336bfb7506325999973864960286d8518797be316e7d3c8`.
- 비밀정보: `.env`/토큰/인증 파일/원본 개인 사건 자료를 포함하지 않음. 코드의 inline 공유 key 값도 제거. 현재 `.env`의 key/token/secret/password 값이 자료에 포함되는지 검사하여 일치 없음 확인.
- 범위: 계획과 제공된 기준 코드에 대한 독립 검수. Pro가 로컬 테스트나 운영 서버 점검을 수행한 것은 아님.

## 결과

1차 판정: **계획 수정 필요 — PLAN REVISE**. GPT-6 Pro는 8분 12초 처리 후 P1 9건과 P2 4건을 제시했다. 테스트 복구와 HTTPS·인증 경계의 최소 수정은 별도 착수 가능하다고 구분했다. 원문은 위 독립 대화에 보존한다.

검수의 핵심은 DB 접수 계약, 최초 외부 전송 전 정보 차단, 검수 증거의 생산자, 승인/머지/실행 버전 결합, crash·DB 복구 후 중복 실행 방지였다. 이 판정은 현재 구현의 배포 승인이나 미래 패치의 AI 승인으로 사용할 수 없다.

## 반영표

모든 지적을 수용해 [계획 v2](../IMPLEMENTATION_PLAN_2026-09-19.md)에 반영했다. 아래 “반영”은 문서의 구현 계약 수정이며 실제 코드에서 결함이 해결되었다는 뜻이 아니다.

| 지적 | v2 반영 위치 | 추가한 핵심 조건 |
|---|---|---|
| P1-01 접수 schema/actor/쓰기 경로 | PR-4 | 기존 evolution_logs 과거 기록 보존, 새 failures/jobs/outbox, actor CHECK/UNIQUE, 단일 RPC 트랜잭션, 기존 직접 INSERT 폐쇄, service_role 서버 권한검사, 1인 운영자의 최종 승인 허용 |
| P1-02 최초 공개 이전 정보 차단 | PR-4/5 | 원본을 합성 패킷으로 전환하고 재현 확인, 외부 AI와 최초 push 이전 반출 경계, 모든 commit/경로/로그/artifact/응답의 canary 시험 |
| P1-03 unknown을 pass로 표시할 위험 | 판정 계약/PR-3 | 서버 필수 검사 집합, assessment_complete와 scoped_pass 분리, no_coverage, 사실 부족≠not_applicable, 본문 일치 별도 검증, 공통 엄격 schema |
| P1-04 worker 권한과 격리 | PR-5 | coordinator/모델 호출부/비신뢰 실행기의 권한 분리, 일회성 hosted runner, 집행 가능한 도구 차단 preflight, 자동 수정 금지 제어 파일 |
| P1-05 검수 증거 생산자 | PR-0/5 | coordinator의 실제 별도 호출, runner의 동일 fixture base/patch 재현, 위조·재사용·다른 실패 이유 거부, mock 상태기계와 실제 AI 증거 구분 |
| P1-06 outbox의 중복 복구 한계 | PR-4 | payload hash 충돌, 고정 branch/operation intent, unknown 보류, lease/fencing, 오래된 worker 차단 및 예산 누적 유지 |
| P1-07 승인 head와 merge/deploy 불일치 | PR-6 | 단일 batch PR, B/H/T/manifest 고정, merge M의 부모·tree 대응 확인, 실제 job/생산자/성공 검사, artifact digest 결합 |
| P1-08 upstream 교체와 검수 유효성 | PR-5/6 | 전체 실행 묶음 fingerprint, 작업 중 버전 고정, 관련 근거 변경 무효화, 1차 cron 후보를 사람 batch에 포함 |
| P1-09 DB 복구와 앱 호환 | PR-0/4/6 | expand-only, 이전 안전 앱의 조회 모드, fail-open rollback 금지, 백업 복원 시험, 외부 효과 대조 후 재개 |
| P2-01 사건 날짜/근거 상태 단순화 | PR-2 | 역할별 사건 날짜, 원문 접근·버전·적용/부칙·후속 해석 확인을 분리 |
| P2-02 HTTPS에 과한 범위 결합 | PR-1 | 기존 SSE+최소 stdio 먼저, 공개 HTTP 차단 종료조건, key fallback 제거, Streamable HTTP/다중 설치기 후속 분리 |
| P2-03 운영 한도/실제 실행 경로 | PR-5/운영 표 | hosted Linux runner와 기존 AGY adapter 선정, 실제 CLI 옵션/모델 목록 확인, 호출·권한검증은 출시 필수, 수치 상한/유료 fallback 금지 |
| P2-04 PR 선후관계 | 최종 순서 | 0→축소 1→4→축소 2→3→5→6, 규칙 파일화와 격리/집계 선행, 구형 개선 endpoint 우회 차단 |

## 1차 범위 조정

HTTPS·설치, 출처/적용시점 표시, FC-01~10의 실제 평가 경로, 코드/규칙 각 1건의 자기수정 루프, GitHub batch 최종 승인까지 유지한다. 다중 설치기, 범용 규칙 언어, 전 기관 상시 수집/변경 그래프, 다중 provider 합의, 별도 관리 UI, upstream 무인 활성화는 후속 범위다.

AGY CLI에서 `gemini-3.1-pro-high` 목록과 print/JSON schema/timeout 옵션을 확인한 것은 접근 가능 모델 목록의 관찰일 뿐이다. 실제 자동 생성·독립 검수 호출, 도구 실행 금지, 운영 quota가 입증되어야 PR-5가 완료된다. 이번 Pro 검수에는 AGY를 사용하지 않았고 ChatGPT의 `6 Pro`를 사용했다.

## v2 재확인

같은 `6 Pro` 대화에 [v2 제출본](PRO_REVIEW_PLAN_2026-09-19_v2.md)을 보내 기존 P1/P2 해소 여부만 한정 재검수했다. 제출본 SHA-256은 `54bb12f72c1fe022da98efc35219006d9941a7521bea568a753d4e5eb01966e7`이다.

2차 판정: **조건부 가능 — 잔여 문구 두 곳을 통일하면 구현 착수 가능한 계획**. 처리 시간은 2분 53초였다. P1-01/02/04/05/06/08/09는 계획 수준에서 해소, P1-03/07은 문구 수정 조건부 해소, P2-01~04도 계획상 해소로 판정했다.

최종 v2.1에서 요청된 두 조건을 반영했다.

1. PR-3: 필수 검사를 skip해 미실행했으면 `assessment_complete=false`. force/warn은 실제 평가 결과·완료 여부를 바꾸지 않고 차단 정책만 변경한다. 우회가 있으면 `scoped_pass=false`.
2. PR-6: 사람은 B/H/T·manifest를 승인하고 이후 M의 부모·tree 대응을 확인해 해당 artifact를 배포한다. M 자체에 대한 별도의 사람 재승인은 요구하지 않는다.

추가로 작성자가 PR-4에 hosted runner 입력도 최초 외부 전송 경계에 포함됨을 명확히 했다. 사전 공개 적격성 검사를 마친 합성 패킷으로 재현을 시험하고, 원본 사건/운영 secrets를 runner에 전달하지 않으며, 새 출력도 게시 전에 검사한다. 이는 두 번째 Pro 제출본 이후의 실행 순서 설명이며 별도의 Pro 재검수를 수행했다고 주장하지 않는다.

검수 상태는 **계획 검수 완료, 구현 검증 대기**다. v2.1 전체에 대한 새로운 세 번째 Pro 판정을 받은 것은 아니다. 기존 코드의 테스트 실패, HTTPS 설정, DB migration, 실제 자기수정 루프는 이 문서 작업으로 해결되지 않았으며 각 PR의 합격 기준을 구현 단계에서 확인해야 한다.
