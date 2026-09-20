# 독자 연구 하네스 구현 계획

상태: 리뷰 REVIEW PASS, 계획 최종 PLAN PASS (`086913b`, PH-01~06 CLOSED). 아래 계약을 기준으로 구현·시험 후 CODE Pro 검수를 진행한다.

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
- 저장 경계: 인증 actor + 서버가 만든 임의 research_id. TTL 30분, 전체 50개/actor당 5개, 세션당 증거 32개, 세션당 1MiB/전체 8MiB 보관 상한. 계획·시도 기록·메타데이터도 바이트 상한에 포함한다. 상한 초과는 명시적 오류. 세션 만료는 성공 판정으로 변환하지 않는다.
- 조회 영수증: evidence_id, 연구 revision, 쟁점 ID와 조회 목적, tool/인수 hash, 관측일, 실제 upstream 이름·버전, 원문 문서 ID(없으면 unknown), 원문 버전(없으면 unknown), 응답 hash, 보관한 passage의 ID·문구·hash와 원문 필드/반환 단위, 본문 범위(body_returned/discovery_only/partial/unknown), 만료 시각. 조회 시각은 법령 최신성 시각이 아니다.
- NTS는 실제 본문 필드(사실관계/질의/회신/이유 등)를 분리한다. 법제처는 실제 반환 텍스트 단위를 보존한다. 출처 종류를 판결·예규·법령의 효력 우열로 자동 판정하지 않는다.
- 본문 보관 상한은 영수증당 128KiB, 32 passage. 초과·upstream 잘림은 partial로 표시한다. 검색 목록, 실패 응답, 메타데이터만으로 본문 확보를 인증하지 않는다.
- plan 갱신 중 진행 중이던 조회는 이전 revision에 저장되지 않는다. actor/세션/revision을 조회 전후 모두 확인한다. 검토 결과는 plan hash, evidence snapshot hash, draft hash, analysis hash, policy version을 묶는다. 이전 revision의 검토 적용 가능성은 무효화한다. 이 구현에서는 메모리 상한을 위해 갱신 시 이전 원문 장부를 비우며 장기 감사 저장소라고 표시하지 않는다. 잘못된 인용은 현재 검토 결과에 그대로 거부 이유와 함께 반환한다.
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

## 계획 검수 보완: 구현 전에 고정하는 계약 (PH-01~06)

이 절의 구체 계약이 앞의 개요보다 우선한다. 각 API에 넘기는 입력은 strict이며 알 수 없는 필드는 400 `INVALID_INPUT`이다. JSON 스키마는 같은 Zod 정의에서 생성한다. 현재 SDK 의존성에 이미 있는 `zod-to-json-schema`를 직접 버전 고정해 사용한다.

### PH-01: 입력·판정

| 객체 | 필수 계약 |
| --- | --- |
| plan | query 1~20,000자; issues 1~12개; facts 0~40개; event_dates 0~12개. 모든 문구는 비공백. ID는 영문 시작 영숫자/밑줄/하이픈 1~64자. 각 컬렉션 ID/날짜 role 유일. |
| issue | id, question(1~1,000자), required_fact_ids(0~40), required_date_roles(0~12). 참조는 실제 plan에 존재해야 한다. timing_required 대신 필요한 역할 배열을 사용한다. |
| fact | id, description, status(provided/unknown/assumed), value(문자열 또는 null), source. unknown은 value=null, provided/assumed는 비공백 값과 출처 설명 필수. provided도 제출자의 진술이지 서버가 확인한 진실이 아니다. |
| event_date | role, value(문자열 또는 null), precision(day/month/year/unknown), basis(provided/assumed/unknown), source. unknown이면 값=null/basis=unknown, 나머지는 정밀도에 맞는 달력 값과 비공백 source 필수. |
| start | `{plan}` → research_id, revision=1, state_version, 고정 expires_at, plan과 장부. |
| status | `{research_id}` → 소유 세션의 plan, evidence(정확한 passages 포함), attempts, state_version, 남은 예산, 마지막 검토 hash의 현재 효력. |
| update | `{research_id, expected_revision, plan}` → 성공 시 revision/state_version 증가, 기존 증거·검토 제거. 입력 전체 검증 후 변경. TTL과 생애 시도 예산은 초기화하지 않음. |
| retrieve | `{research_id, expected_revision, issue_ids(1~12), purpose(support/counter/context/timing), tool, arguments}`. 인수 직렬화 최대 16KiB. 날짜 조회는 아래 계약을 추가 적용. → 현재 장부 상태와 발급된 evidence/passages, 성공·실패·0건 시도 상태. |
| review | `{research_id, expected_revision, expected_state_version, draft_answer(1~50,000), analysis(1~12), correction_needed:boolean}`. 각 issue_id가 정확히 한 번. |
| issue analysis | issue_id, conclusion_mode(definitive/conditional/withheld), claims(0~12), withholding_reason, unknowns, next_queries, counter_evidence, timing, exceptions. 주장 0개는 withheld+비공백 유보 이유일 때만 가능. |
| claim | id(전체 분석 내 유일), text(1~3,000), requirements(1~8 비공백 문구), fact_ids, citations(0~8). claim text는 정확한 draft 부분 문자열이어야 한다. |
| citation | evidence_id/passage_id, quote(비공백 1~3,000자), relation(direct/analogy/background), reason. quote는 원래 passage의 연속 부분 문자열만 허용. 다른 등록 쟁점의 자료 재사용 시 별도 bridge_reason 필수. |
| counter_evidence | evidence_id, disposition(resolved/unresolved/irrelevant), reason. 해당 쟁점의 counter 자료는 모두 처리해야 한다. 인용 실존 외 의미 판정은 모델의 선언이다. |
| timing / exceptions | status(addressed/unresolved/not_required), reason; timing은 date_roles를 함께 제출하여 필요한 역할 전체와 대조. 예외 검토 not_required도 이유 필수. |

Zod 문법 오류·중복 계획 ID·잘못된 계획 참조는 HTTP 400. 존재하지 않는 세션/다른 소유자는 동일한 404 `RESEARCH_NOT_FOUND`. stale revision/state_version은 409 `RESEARCH_REVISION_CHANGED`/`RESEARCH_STATE_CHANGED`. 같은 세션의 진행 중 조회와 충돌하는 변경·검토는 409 `RESEARCH_BUSY`다.

검토 결과는 다음 우선순위를 적용한다:

1. **blocked**: 허위/중복/누락 쟁점·주장·사실 참조, 없는 증거/passage, quote 불일치, 초안에 없는 claim, 쟁점 간 bridge 누락, discovery/unknown 자료를 본문 인용으로 제출, 모델의 definitive 선언과 알려진 공백의 모순. 잘못된 citation 원본과 이유를 반환한다.
2. **needs_info**: 위 구조 오류는 없으나 등록 필수 사실 전체 중 unknown/assumed, 부족한 직접 자료, 부분 본문, 필요한 날짜 역할/정밀도/시점 검토 누락, 미해결 반론, counter 검색 미실시·실패·0건 또는 시도 예산 소진 등 공백. 조건부/유보가 이를 설명해도 이 상태를 유지한다. 답변 표시 금지는 아니다.
3. **structurally_complete**: 등록된 범위의 위 오류/공백 없음. 의미·정답·법률 승인 필드는 계속 unverified. counter 검색에서 자료가 나와 처리됐다는 것만 검사하며 모든 반례를 찾았다는 의미가 아니다.

필수 사실은 used fact_ids가 아니라 issue.required_fact_ids **전체**에서 검사한다. 모든 definitive claim에는 해당 쟁점에 연결된 유효한 직접 인용이 필요하다. relation=direct의 의미상 거짓까지 판정하지 않는다. 부분 본문도 quote_match=true일 수 있으나 body_scope=partial을 유지하며 확정 결론을 막는다. 결과 JSON은 MCP structuredContent와 text content에 동일하게 반환한다.

### PH-02: 동시성·장부 버전·예산

- 최소안은 **세션마다 조회 하나만 진행**시키는 것이다. 그 동안 추가 조회/update/review는 `RESEARCH_BUSY`, status만 허용한다. 서로 다른 세션은 기존 전체3/provider2 제한 안에서 실행한다.
- state_version은 plan 변경, 조회 접수, 완료/실패 때 증가한다. evidence snapshot hash에는 현재 revision의 원문과 전체 시도 상태·목적·실패/0건도 포함한다. 리뷰는 expected_state_version을 받고 동기 검사한다. 결과는 해당 순간의 스냅샷이며 새 조회 접수만으로 last_review.current=false. 리뷰 본문을 장기 보관하지 않고 hash 요약만 둔다.
- TTL은 start부터 고정 30분, 시도 40회는 세션 수명 전체다. update는 이를 충전하지 않는다. 이전 revision 시도는 작은 상태 기록으로 남기고 원문만 제거한다.
- upstream 호출 전에 시도 자리, receipt 자리, receipt 최대 128KiB와 실패/메타데이터용 8KiB를 예약한다. 증거 32개와 시도40회에 도달했거나 세션/전체 byte 여유가 없으면 429 `RESEARCH_CAPACITY`이며 upstream 호출 0회. 각 호출은 하나의 receipt, SourceVerifier의 역할은 그 receipt 안 독립 unit으로 보존한다.
- 현재 보관 JSON UTF-8 bytes + 진행 중 예약을 합산한다. 상한은 임시 파싱 객체나 Node/Python 전체 RSS 한도가 아니다. 완료 시 예약 주체·actor·세션 동일성·revision·만료를 재확인하고 증거/시도/용량을 동기 갱신한다. 만료 또는 종료 뒤 결과는 버린다.
- 실제 조회 timeout/프로세스 회수는 기존 managed provider가 수행한다(일반45초 이내, SourceVerifier 전체32초). timeout 오류는 실패 시도로 남기며 늦은 프로세스 응답을 성공으로 바꾸지 않는다. 임의 provider promise를 제품에 주입하는 API는 없다. 테스트는 실제 stdio timeout/종료 경로와 만료 후 수동 응답을 각각 확인한다.

### PH-03: 원문 adapter 허용표

범용 `execute_tool`, `legal_analysis`, 임의 URL/임의 중첩 작업은 새 연구 조회에서 허용하지 않는다(400 `RESEARCH_TOOL_NOT_ALLOWED`). 기존 직접 조회 API는 호환 유지한다. 도구별 입력은 현재 제공자가 광고한 스키마를 따르며 아래 해석은 도구명과 반환 형식을 모두 확인한다. 모르는 형식의 문자열을 재귀 탐색하지 않는다.

| 허용 도구 | 추출·식별·범위 |
| --- | --- |
| search_law, search_decisions, legal_research | discovery_only. 검색 결과를 제한된 passage로 반환하여 다음 조회 ID를 얻도록 한다. 본문이 섞여 있어도 직접 본문 증거로 승격하지 않는다. |
| get_law_text | content.text의 법령명/시행일 등 metadata와 실제 조문 반환 단위. 목차(총 …개 조문)는 discovery_only, 조문 없는 형식은 unknown. 제목만 있는 행은 본문 passage가 아님. MST/lawId와 반환 시행일(없으면 unknown), 선택 jo 기록. 응답 크기 제한/축약 표시는 partial. 제공자 텍스트의 설명·경고가 섞일 수 있어 raw XML 원문 인증이라고 하지 않음. |
| get_decision_text | full=true일 때 알려진 본문 섹션을 제공자 text에서 추출. full 미지정/false 또는 축약 표시는 partial. 메타만 있거나 형식을 인식 못하면 unknown. domain/id로 식별. NTS로 재라우팅되면 다음 NTS adapter 적용. |
| lookup_tax_document, get_tax_document, lookup_local_tax_document | normalized structuredContent.document의 facts/question/answer/reasoning/conclusion/claimantView/agencyView/relatedLawsText 문자열만 본문 후보. documentNumber/ntstDcmId/sourceUrl, provider pin, 본문 hash로 식별. bodyUnavailable/에러는 본문 없음, compact/include_full_text=false/잘림 표시는 partial. NTS 필드 분리는 의미적으로 정답임을 보장하지 않는다. |
| search_tax_interpretations, search_tax_decisions, search_tax_guidance, get_tax_guidance, search_tax_forms, search_taxlaw, tax_research, search_local_tax_interpretations, search_local_tax_decisions | discovery_only. guide/복합 조사 결과는 본문 계약을 확정하지 않았으므로 본문 증거로 승격하지 않음. |
| check_legal_sources | SourceRequest의 기존 허용 인수만 받음. 최상위 unavailable이면 실패, previous는 항상 제외. 현재 current_result와 available인 historical_observations만 독립 unit으로 추출. 각 unit에 role/date/access/scope; 실패 역할은 passage 없이 기록. 법령 현재 텍스트는 위 get_law_text 규칙. 역사적 복합 텍스트는 unknown으로 보수 처리하고 별도 원문 조회를 안내. |

provider의 isError, 기존 LawMcpError, NTS 애플리케이션 오류는 failed 시도이며 새 원문 receipt 없음. 알려진 search total=0/items=[]는 empty 시도로 보존. 영수증은 서버가 보관한 **제공자 반환 텍스트**의 증명이며 제공자의 parsing 오류나 캐시 무효화를 증명하지 않는다. 자료 자체의 지시를 실행하지 않는다. community correction은 호출·해시·본문 추출에서 모두 제외한다.

### PH-04: 날짜 역할 연결

각 issue.required_date_roles는 plan.event_dates.role을 참조한다. review.timing.date_roles는 필요한 역할을 모두 명시해야 한다. definitive는 해당 날짜가 모두 provided/day이고 시점 검토가 addressed여야 한다. 월/연도만 알고 있을 때 conditional/withheld로 보충 질문을 돌려줄 수 있다.

연구 경로의 check_legal_sources.arguments.event_dates는 plan의 **동일 역할·동일 값·provided/day**와 정확히 같아야 한다. 다른 역할의 날짜, 임의 15일 보정, 가정 날짜는 400 `RESEARCH_DATE_MISMATCH`, upstream 0회. 현재 원문만 보는 event_dates={}는 허용하지만 과거 역할 완료를 의미하지 않는다. 기존 SourceRequest에 없는 역할은 지원하지 않는다고 반환한다. get_law_text의 efYd는 법령 버전의 시행일 선택이지 사건일로 등록하지 않는다.

### PH-05: 고정 oracle와 변형 시험

합성 원문: `합성 규정 본문입니다. 공동 취득분은 기록된 원가에 따라 구분합니다.`; 이는 실제 세법 정답이 아니다. 기본 plan은 partition/cost 두 쟁점, 각각 필요한 사실을 등록한다. 정상 대조는 원문을 각각 support/counter 목적에서 받고 counter에 irrelevant+이유를 명시한 단일 쟁점 최소 입력으로 한다.

| 계약 | 구체 예상값·부작용 |
| --- | --- |
| RH-01/02 | 5개 REST 무인증=401; status/update/retrieve/review 다른 actor=404; stale revision=409; 위조·같은 actor 다른 세션 evidence=blocked/EVIDENCE_NOT_FOUND. 모든 거부에서 upstream/GitHub 0회, 원래 장부 불변. MCP 동일 정상/오류도 검사. |
| RH-03/04 | 정상 quote=true; 빈 quote=400; 변조·passage 교체·떨어진 구절 결합=blocked/QUOTE_MISMATCH 또는 PASSAGE_NOT_FOUND. 부분 본문 quote=true이나 needs_info(conditional)/blocked(definitive). 목차·제목만·unknown 인용=blocked. 현재 실패+previous 존재=failed/원문0; 현재 성공+과거 실패=역할 실패 보존. |
| RH-05/06 | 빈 plan issues/중복 plan ID/모순된 fact=400. 누락 issue·중복 claim·없는 fact=blocked. required fact unknown을 claim.fact_ids에서 빼도 conditional=needs_info, definitive=blocked. 타 쟁점 receipt에 bridge_reason 없으면 blocked/ISSUE_BRIDGE_REQUIRED, bridge를 적어도 semantic_support=unverified. |
| RH-07 | 2025-03(month)는 문자열 그대로 보존. 이를 transfer=2025-03-15로 조회하면400/upstream0. 정확한 provided/day만 실제 provider 인수로 전달. 윤년/잘못된 날짜 및 기존 Analyze/SourceRequest 회귀. |
| RH-08 | 지연 조회 중 update/review/두번째조회=409 RESEARCH_BUSY; 실패 update는 장부 유지. 40번째 뒤41번째/32번째 뒤33번째/byte 부족은429+추가upstream0. 만료 후 도착은404+증거0. stdio timeout 뒤 늦은 응답·새 child와 혼동 없음. 서로 다른 세션이 전체 byte 예약을 동시에 초과하지 않음. |
| RH-09 | 고정 JSON 정렬 규칙과 독립 SHA-256으로 draft/plan/analysis/snapshot 입력 확인. 각각 바꾸면 해당 hash 변경. 조회 접수 순간 state_version 변경+last_review.current=false, 이전 expected_state_version 재사용409. policy 변경도 review binding hash 변경. |
| RH-10/11 | 연구 다섯 호출 및 원문 속 게시 지시에서 GitHub 쓰기0. 기존 preview+target+동의 hash 회귀 유지. MCP text JSON=structuredContent. Actions request/response AJV와 실제 REST, passage text/ID 일치. |
| RH-12 | clean package+실제 stdio bridge 시험은 CODE 증거. Linux CI 고정commit 성공. 이후 GCE HTTPS 실제 원문+구조 검사+잘못된 인용 거부는 배포 증거. |

초기 feature RED와 별개로 구현 후 격리된 임시 빌드에서 quote 대조/actor 경계/필수 사실 검사 각각을 의도적으로 무력화하고 관련 시험이 실패하는지 확인한 뒤 원본 빌드를 재검증한다. 운영/작업 소스에 변이를 배포하지 않는다.

### PH-06: 배포 실행 경계

사용자가 이번 요청에서 **리뷰·계획·구현·배포 진행을 명시적으로 승인**했다. Pro의 PLAN/CODE 판정은 그 승인과 별개인 기술 검수다. CODE 검수 해소 및 릴리스 준비 조건을 충족하면 기존 승인 범위에서 전환하며 중복 승인을 요청하지 않는다.

후보 smoke는 별도 loopback 포트, 임시 상태, correction 게시자 미설정으로 실행한다. 운영 correction 디렉터리와 GitHub 게시 자격을 후보에 연결하지 않는다. 실제 NTS 읽기만 허용한다. CPU/RSS/디스크와 운영+후보 동시 실행 여유를 실측한다.

전환 불변조건은 **새 작업 진입이 차단되고, 이미 수신된 요청의 인증·디스패치 대기를 포함하여 앞으로 새 작업이 시작될 경로가 없으며, 진행 중 게시·조회가 모두 끝난 상태**다. 단일 active_requests=0 관측은 이 증명이 아니다. 기존 a9808dd는 authActive를 health에 노출하지 않으므로 이 수치만으로 전환하지 않는다. 새 코드에는 접수 차단 후 인증 완료 시에도 재확인하는 drain 경계와 auth/작업 대기의 정리 조건을 추가하고 지연 인증 회귀를 시험한다. 기존 운영본에서 동등한 조건을 입증할 수 없으면 실제 전환을 하지 않는다.

기존본의 외부 drain은 이 서비스의 Cloudflare→loopback 포트만 차단하고 기존 ingress 연결도 정리해, 아직 요청 본문/소켓에 남은 내용에서 새 디스패치가 생기지 않게 해야 한다. 이미 진입한 인증은 고정 운영 artifact의 실제 인증/SDK 경로에서 확인한 최대 실행 한도가 끝나야 한다. 현재 로컬 코드는 단일 JWT getUser fetch에 5초 AbortSignal이며 자동 재시도/세션 갱신 경로를 사용하지 않는 것을 확인했다. 배포 전 운영 의존성·코드 일치와 이 한도를 재확인하고 해당 대기 및 event-loop 진행 확인 뒤 active 작업 0을 확인해야 한다. 네트워크 fence만 설치하거나 임의로 몇 초 잤다는 것을 drain 증거로 사용하지 않는다. 포트 전용 격리는 다른 서비스/SSH를 보존한다. 현재 cloudflared는 root, operator probe는 cta인 것을 확인했으므로 해당 포트·UID에 한정한 수단을 검토한다. 증명 조건 미충족 또는 60초 내 정리 실패면 전환 중단. 진행 중 correction 게시를 강제 중단하지 않는다.

rollback 기준은 전체 commit `a9808ddd629f18cb915e710bf52835fe6db400e5`와 기존 artifact SHA `c0977a5e3508d02c1340cde15307b05ba8c10413c14fb182f96809b584df1561`, 실제 파일 hash manifest, systemd 70-client-guide drop-in/환경 참조를 재확인해 고정한다. 새 전환 drop-in만 제거하여 이 상태로 돌아가며 correction 영속 파일을 과거 사본으로 덮어쓰지 않는다. 새 Python pin/실제 의존성·venv 위치, Node artifact SHA, CI/commit, health/HTTPS smoke를 배포 packet에 기록한다.

공개 재개는 cleanup과 분리한다. 전환 전 중단이면 기존 릴리스가 그대로 정상임을 확인한 뒤 해제, 전환 성공이면 새 릴리스 식별·readiness 후 해제, rollback 성공이면 이전 릴리스 식별·readiness 후 해제한다. **rollback 실패/실행 상태 불명이면 해당 서비스만 maintenance/차단 유지**하고 실패를 기록한다. finally에서 무조건 fence를 해제하지 않는다. 임시 자원 정리 때문에 실패 후보가 다시 공개되어서는 안 된다.

배포 준비 시험에 (a) active=0 때 인증 대기 중인 게시 요청이 뒤늦게 완료되어도 drain이 거부하거나 안전하게 정리될 때까지 전환 금지, (b) 후보 readiness 실패+rollback 실패가 함께 발생하면 public resume 호출 0회인 두 실패 주입을 추가한다. 이 시험과 실제 기존본 drain 증거는 CODE/배포 검수 packet에서 확인한다.
