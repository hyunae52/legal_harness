# 독립 연구 하네스 구현·검증 기록

2026-09-21. 설계 기준: [고정 계획](RESEARCH_HARNESS_PLAN.md), [참조 저장소 리뷰](HARNESS_REFERENCE_REVIEW.md).

## 구현한 동작

LLM을 서버에 종속시키지 않고 REST와 MCP에서 같은 연구 세션을 사용한다. `start_legal_research` → `research_legal_sources` → `review_legal_reasoning` 순서로 쟁점·필수 사실·날짜 역할, 실제 반환 원문, 제출된 답변을 연결한다. `update_legal_research`와 `get_legal_research`로 수정·조회한다. OpenTax/tax-agent 구현을 복사하지 않고 독자적인 TypeScript 계약·장부·검사기를 작성했다. 기존 zisu17 NTS 제공자는 고정 커밋의 별도 프로세스로 유지한다.

- `src/researchContracts.ts`: strict Zod 입력과 같은 정의에서 생성한 MCP/Actions 스키마.
- `src/research.ts`: actor·세션·revision·state_version 경계, 고정 30분 TTL, 조회 예약과 JSON byte 예산. 수정·재조회 후 이전 검토를 현재 검토로 표시하지 않는다.
- `src/researchEvidence.ts`: 도구별 반환 형식 허용표. 검색 목록, 부분 본문, 인식하지 못한 형식, 실제 반환 본문을 구분한다. 실패·0건은 기록하고 SourceVerifier의 previous 캐시를 새 원문으로 승격하지 않는다.
- `src/researchReview.ts`: 인용의 정확한 부분 문자열, 쟁점·주장·필수 사실·날짜·반론 연결 검사. 잘못된 인용 원본과 이유를 그대로 돌려준다. 최종 draft/analysis/plan/evidence/policy 해시를 결합한다.
- `src/app.ts`, `src/index.ts`: REST/MCP 공통 처리, 인증 중 요청과 실제 작업까지 포함하는 종료 drain. 인증 뒤에도 접수 중단을 다시 확인한다.
- `scripts/rollout-gate.mjs`: 후보 또는 이전 릴리스가 검증된 경우에만 공개 재개. rollback 실패 시 차단을 유지한다.

검사 결과는 `blocked`, `needs_info`, `structurally_complete`다. 마지막 값도 **법률 정답, 의미적 지지, 독립 AI 심사 통과를 뜻하지 않는다**. 해당 필드는 계속 `unverified`/`not_performed`다. 실패 조회 후 다시 성공해도 현재 revision에 남은 공백을 숨기지 않는다. 쟁점 자체의 완전성과 미제출 주장까지 보증하지 않는다.

필수 사실 누락·부분 본문·날짜 정밀도 부족이 있으면 확정 결론을 막고 조건부/유보 결론에 추가 질문을 요구한다. 보정 제안은 공개 초안 준비 도구를 안내할 뿐, 연구 자료를 GitHub에 자동 게시하지 않는다. 기존 공개 preview·저장소·명시적 동의 후 draft PR 생성 경계를 유지한다.

## 검증 증거

초기 RED는 새 REST 경로 부재(404), 새 MCP 도구 부재를 확인했다. RH-01~12에 대응하는 시험은 `tests/research-harness.test.mjs`, `tests/research-rollout.test.mjs`에 있다. 법률의 정답 대신 고정된 합성 자료와 프로토콜·상태·부작용을 oracle로 사용한다.

| 검증 | 관측 결과 |
| --- | --- |
| 구현 전 기준 | 기존 review 103개 통과 |
| 새 하네스·배포 경계 표적 시험 | 22개 통과, skip 0 |
| 전체 회귀 | `npm run review` 125개 통과, 실패·skip 0 (50.6초) |
| 설치 패키지 | clean install, 설치된 패키지에서 앱 import, 실제 stdio→SSE 연구 호출 포함 7개 통과 |
| 실패 주입 | 인용 대조·actor 검사·필수 사실 검사를 각각 제거한 격리 빌드 3개 모두 assertion으로 실패. 작업 빌드 hash 불변 |
| 실제 원문 조회 | REST+MCP SSE 35개 도구; `서면-2020-부동산-4503` 실제 반환 본문 4개 passage |
| 실제 원문 검사 | 정확한 quote=true, 사실 미확인=needs_info, 위조 quote=blocked, 법률 검수=unverified, GitHub 쓰기 0 |

실제 원문 관측: 2026-09-20T19:16:37.982Z. NTS 제공자 `korean-taxlaw` 2.0.0, 커밋 `d77c94e5b64892fe85928508544366e418397c71`, 반환 해시 `5c94093c787ba6a917f6c0c54b44d661a1b8c71d4a3b024525dbfdcbad42e1f6`. 이 행은 **로컬 loopback** 증거다. 운영 HTTPS 검증은 별도 배포 기록에 남긴다.

패키지 시험 artifact SHA-256: `7bd683a54b6acaee66de5988926800551a59519f1180c3dbc7ee38a31d383657`. 운영 배포에는 실제 선택한 artifact·commit·Linux CI·설치된 의존성 파일 지문을 다시 결합한다.

## 한계와 운영 계약

장부는 메모리에만 있고 재시작/30분 만료 시 사라진다. 사용자당 5개, 전체 50개 세션, 세션당 조회 40회·증거 32개·1MiB, 전체 8MiB다. 128KiB receipt 및 메타데이터 8KiB를 호출 전에 예약한다. 이 수치는 Node/Python 전체 RSS 또는 임시 파싱 객체의 메모리 상한이 아니다.

법제처 도구는 제공자가 반환한 텍스트를 검사하며 raw XML의 인증을 제공하지 않는다. 인식하지 못하는 판례/역사적 복합 본문은 unknown으로 유지한다. `quote_match=true`는 의미적 법률 적용이 맞다는 판정이 아니다. 제공자 캐시, 원문의 후속 변경·폐기 여부까지 별도의 근거 없이 최신이라고 단정하지 않는다.

## 단계별 Pro 검수

- REVIEW: PASS. 인용 삭제 후 검증, 최종 답변 변경 후 미검증, 독립 검수 과장 문제를 참조 리뷰에 반영했다.
- PLAN: PASS. PH-01~06 입력·동시성·adapter·날짜·시험·drain/rollback 계약까지 검수했다.
- CODE: 제출 준비 중. 실제 실행은 Codex가 수행하며 Pro의 정적 검토와 구분한다.
- DEPLOYMENT: 미실행. CODE 지적 해소 및 고정 릴리스 준비 후 기존 사용자 승인 범위에서 진행한다.
