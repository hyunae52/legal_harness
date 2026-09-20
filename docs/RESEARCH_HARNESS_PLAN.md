# 독자 연구 하네스 구현 계획

상태: 리뷰 단계 Pro 응답을 기다리며 작성한 계획 초안. 제품 구현 전 별도 Pro 계획 검수를 받는다.

## 사용자에게 보이는 결과

AI가 질문의 쟁점·필요한 사실을 등록하고 공식 원문을 조회한 뒤, 답변 초안과 주장별 근거를 제출한다. MCP는 그 연구에서 실제로 받은 자료와 인용을 대조하여 **고칠 구조 오류, 추가 확인할 사실, 보충 검색, 남은 반론**을 반환한다. 원문 안의 문장이 일치해도 법률 판단이 맞다고 인증하지 않는다. 다른 근거 때문에 답변을 바꾸면 기존 교정 PR 미리보기와 사용자 동의 흐름으로 안내한다.

서버에 별도 LLM API나 벡터 DB를 요구하지 않는다. 연결된 모델이 분석을 작성하고 서버는 유한한 자료·계약을 검사한다. 연구 세션은 메모리에만 보관하며 재시작 또는 만료 시 다시 시작한다. 세션 ID를 모르면 복구할 수 없고, 공유 접속키 사용자는 동일 인증 주체이므로 개별 고객 격리라고 설명하지 않는다.

## 인터페이스

REST와 MCP가 같은 서비스 메서드·엄격한 Zod 입력 계약을 사용한다. MCP와 GPT Actions 양쪽에 사용 순서를 제공한다.

| MCP 도구 | REST | 동작 |
| --- | --- | --- |
| `start_legal_research` | POST `/api/research/start` | 질문, 쟁점, 필요한 사실, 역할별 사건일 등록. 서버 UUID와 revision 발급 |
| `update_legal_research` | POST `/api/research/update` | 예상 revision 확인 후 연구 계획 교체. 이전 증거와 검토 결과 무효화 |
| `get_legal_research` | POST `/api/research/status` | 소유한 세션의 계획·증거 목록·만료 시각 조회 |
| `research_legal_sources` | POST `/api/research/retrieve` | 허용된 기존 원문/검색 도구를 직접 호출하고 서버 증거 영수증 발급 |
| `review_legal_reasoning` | POST `/api/research/review` | 정확한 초안과 구조화된 논증을 서버 기록과 대조 |

기존 `/api/analyze`, `validate_legal_draft` 등은 호환 유지한다. 기존 도구 결과를 클라이언트가 새 장부에 업로드해 “조회 완료”로 등록하는 경로는 제공하지 않는다. 새 하네스를 호출하지 않은 답변은 이 검증을 받은 것이 아니다.

## 데이터와 상태

- 연구 계획: query, issues(id/question/required_fact_ids/timing_required), facts(id/description/status/value/source), event_dates(role/value/precision/basis). 미상과 가정을 제공된 사실로 바꾸지 않는다. 유효한 달력 날짜·월·연도를 검사하고 월→임의 일자 보정을 금지한다.
- 저장 경계: 인증 actor + 서버가 만든 임의 research_id. TTL 30분, 전체 50개/actor당 5개, 세션당 증거 32개, 세션당 1MiB/전체 8MiB 보관 상한. 상한 초과는 명시적 오류. 세션 만료는 성공 판정으로 변환하지 않는다.
- 조회 영수증: evidence_id, 연구 revision, 쟁점 ID와 조회 목적, tool/인수 hash, 관측일, 실제 upstream 이름·버전, 응답 hash, 보관한 passage의 ID·문구·hash, 본문 범위(body_returned/discovery_only/partial/unknown), 만료 시각. 조회 시각은 법령 최신성 시각이 아니다.
- NTS는 실제 본문 필드(사실관계/질의/회신/이유 등)를 분리한다. 법제처는 실제 반환 텍스트 단위를 보존한다. 출처 종류를 판결·예규·법령의 효력 우열로 자동 판정하지 않는다.
- 본문 보관 상한은 영수증당 128KiB, 32 passage. 초과·upstream 잘림은 partial로 표시한다. 검색 목록, 실패 응답, 메타데이터만으로 본문 확보를 인증하지 않는다.
- plan 갱신 중 진행 중이던 조회는 이전 revision에 저장되지 않는다. actor/세션/revision을 조회 전후 모두 확인한다. 검토 결과는 plan hash, evidence snapshot hash, draft hash, analysis hash, policy version을 묶는다.
- 원문은 신뢰하지 않는 데이터다. 하네스는 문서 안의 지시를 실행하지 않고 프롬프트/검토 packet에서도 이 경계를 안내한다. 본문이나 사건 내용을 로그·GitHub에 자동 저장하지 않는다.
- 기존 `check_legal_sources`도 연구 조회 안에서 사용할 수 있게 하여 새 프로세스의 현재/역할별 과거 원문을 증거로 남긴다. 성공한 역할과 실패한 역할을 각각 보존하고 일부 성공을 전체 성공으로 승격하지 않는다. 이 경로도 부칙 해석이나 후속 예규의 효력을 승인하지 않는다.
- 기존 머지 교정 메모는 `community_correction` 자료이며 공식 원문 영수증과 섞지 않는다. 연구 증거는 upstream 원문/검색 결과에서만 발급하고 교정 검색 결과를 원문 증거로 다시 주입하지 않는다.
- 조회 시도는 성공/실패/0건을 구분해 최대 40건 보관한다. 실패해도 그 시도를 삭제하거나 최신성 성공으로 바꾸지 않는다. 검색 예산 소진·0건은 특정 범위에서 찾지 못했다는 뜻이며 규정 부재·반례 부재의 증거가 아니다.
- 단계 상태는 completed/skipped/failed/not_configured와 검사 범위를 분리한다. 서버 결정론적 검사만 completed가 될 수 있고 별도 의미 검수자는 기본 not_configured다. 클라이언트가 보내는 검수자 이름만으로 상태를 완료로 바꾸는 API는 없다.
- 기존 `AnalyzeSchema.event_dates`와 `SourceRequest`의 일 단위 값은 공통 실제 달력 날짜 검증으로 맞춘다. 새 연구 API만 월·연도·미상 정밀도를 지원하며 기존 입력 형식을 임의로 변경하지 않는다.

## 논증 검토 계약

모델은 쟁점마다 결론 상태(definitive/conditional/withheld), 주장, 요건, 사용 사실 ID, 인용(evidence_id/passage_id/quote/관계/direct·analogy·background/적용 이유), 반대 근거와 처리 이유, 미확인점, 보충 검색어, 시점·예외 검토 내용을 제출한다. 이것은 모델이 작성한 분석이며 독립 검수 완료라고 표시하지 않는다.

서버 검사:

1. 등록 쟁점이 각각 한 번만 등장하고 허위 쟁점·사실 ID가 없는가.
2. 인용 증거가 이 actor/세션/revision에서 실제 발급되었고 아직 유효한가.
3. quote가 선택한 passage의 실제 부분 문자열인가. 공백/개행을 임의 제거하여 서로 떨어진 구절을 합치지 않는다.
4. 검색 목록·본문 미확보·부분 본문을 완전한 근거로 승격하지 않았는가.
5. 확정 결론에 미상/가정인 필수 사실, 부분 자료, 미해결 반론, 미검토 시점·예외가 남지 않았는가. 조건부/유보 결론은 공백과 다음 확인을 명시해야 한다.
6. 직접 근거가 없으면 직접 근거가 없는 상태를 유지하는가. 유추·배경 설명을 직접 근거로 자동 승격하지 않는다.
7. counter 목적의 조회가 등록됐으면 해당 증거를 반론 또는 무관한 자료 제외 이유로 처리했는가. 검색되지 않거나 모델이 제출하지 않은 모든 반례를 발견했다고 주장하지 않는다.
8. 사용한 주장 문구가 제출 초안에 그대로 존재하는가. 초안의 다른 문장 전부까지 포괄했다고 주장하지 않고 claim coverage를 `submitted_claims_only`로 표시한다.

서버는 잘못된 인용을 지워서 분석을 통과시키지 않는다. 검사 결과에 해당 인용과 거부 이유를 남긴다. 조회·시점·내용의 일부 성공을 전체 단계 완료로 합치지 않는다. 구조적 완전성은 **등록된 계획과 제출된 주장만**의 완전성이며 질문 전체의 법률 쟁점을 모두 발견했다는 뜻이 아니다.

반환: `status=blocked|needs_info|structurally_complete`, 구조 오류 목록, 쟁점별 공백·다음 확인, 정확한 draft hash. 항상 `legal_verification=unverified`, `semantic_support=unverified`, `independent_review=not_performed`. 구조 검사 통과를 법률 승인·배포 승인처럼 표시하지 않는다. 보충 검색 자동 무한 루프는 없다.

정정 필요성을 모델이 신고한 경우 기존 `prepare_correction_pr` 사용 안내와 사용자에게 보여줄 질문을 반환한다. 실제 PR 작성에는 기존 공개 안전 확인과 사용자 동의가 별도로 필요하다. 이 검토 호출 자체는 PR을 게시하지 않는다.

## 실행 가능한 시험 계약

기존 Node test runner를 사용한다. 구현 전 공개 HTTP/MCP 경계의 누락 기능 실패(404/도구 부재)를 기록하고, 구현 후 단위·통합 계약을 같은 입력으로 검증한다. 별도 라이브러리 프레임워크를 추가하지 않는다.

| ID | 관측 가능한 계약 | 검증과 독립 oracle |
| --- | --- | --- |
| RH-01 | 인증된 연구 도구가 REST/MCP에 노출되고 무인증 요청은 upstream 호출 전 거부 | 실제 Express+SDK, 고정 합성 자료 |
| RH-02 | 다른 actor/다른 세션/위조·미조회 증거의 인용이 거부됨 | 서버가 발급한 ID와 별도 세션 비교 |
| RH-03 | 실제 본문 구절만 대조 성공, 제목·목록·조작된 구절은 근거가 되지 않음 | 독립 fixture 원문과 바꾼 인용문 |
| RH-04 | NTS 부분 본문·잘림·자료 없음·에러는 확정 근거로 승격되지 않음 | 기존 실제 stdio fixture와 body metadata |
| RH-05 | 쟁점/사실 누락, 가정·미상, 미해결 충돌이 확정 결론을 막음 | 고정 사건 계획과 변형된 분석 |
| RH-06 | 분할 해당 여부와 분담금 원가배분 쟁점을 분리하고 유추·직접 근거를 구분 | 두 쟁점 중 하나만 근거가 있는 합성 사례. 세법 정답 자체를 자동 채점하지 않음 |
| RH-07 | 월·연도·미상 날짜를 임의 일자로 바꾸지 않음 | 경계 월/윤년/역할별 값 확인 |
| RH-08 | TTL·용량·동시 갱신·재시작 경계에서 fail closed | 주입한 시계·낮춘 상한·지연 provider로 시험 |
| RH-09 | 검토 결과는 정확한 초안/계획/증거에 결합되고 법률·독립 AI 승인으로 표시되지 않음 | 다른 초안 hash 비교, 고정 미검수 상태 |
| RH-10 | 교정 안내는 나오지만 GitHub 쓰기·머지는 발생하지 않음 | 기존 교정 계약 회귀 + 조회 호출에서 쓰기 0 |
| RH-11 | GPT Actions 스키마·사용 지침과 실제 경로가 일치 | AJV와 실제 요청, 기존 setup 회귀 |
| RH-12 | 설치 산출물 및 GCE HTTPS에서 같은 코드·도구·원문 흐름이 동작 | package smoke, artifact SHA, 공개 HTTPS MCP/REST 실제 NTS 읽기 |

## 단계와 배포

1. 참고 소스 리뷰 → Pro 리뷰, 지적사항 대조·기록.
2. 이 계획과 계약 → Pro 검수. 필수 지적을 반영하고 계획 고정.
3. RED→GREEN, 전체 review/package 및 Linux CI → 정확한 commit 대상으로 Pro 구현 검수.
4. 기존 GCE에 새 릴리스를 별도 디렉터리로 stage. 검토된 NTS Python pin을 격리 venv에 설치하고 의존성 목록을 남김. 기존 환경 비밀값을 출력하거나 Python에 전달하지 않음. 현재 systemd/Cloudflare 구성과 correction 영속 디렉터리 보존.
5. 서비스 전환 전에 loopback 새 릴리스 smoke. 준비 완료 후 systemd drop-in으로 한 번 전환. readiness/인증/도구/실제 NTS 원문/구조 검토를 HTTPS로 확인. 실패하면 직전 `a9808dd` drop-in 상태로 복귀.
6. 실제 배포 증거와 동일 artifact/commit을 Pro에 전달해 배포 검수. 남은 지적은 적용 범위를 판단해 수정·재검증하고 기록.

현재 운영 관측: `/home/cta/legal-harness-client-guide-a9808dd`, `legal-harness-a.service` active, Python 3.13.5, 메모리 available 약 408MiB, 디스크 여유 약 2.2GiB. 이 값은 사전 관측이며 활성화 직전에 다시 확인한다. 추가 유료 서버/API를 먼저 요구하지 않는다.
