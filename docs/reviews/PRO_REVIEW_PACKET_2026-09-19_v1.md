# Independent Pro plan review packet — 2026-09-19
This is a planning review. No implementation has been changed. Baseline commit d41e4588ecd374eedf5a7a846942ce27a17bf7f5. Tests and live observations below were made by the preparing agent, not by the independent reviewer. Inline shared-key fallback is redacted. No .env, credentials, personal case records, or private browser content is included.
# Legal Harness 수정 계획

상태: v1 — 독립 Pro 검수 제출본. 구현·배포·머지는 아직 수행하지 않음.

기준: `hyunae52/legal_harness`, `main@d41e4588ecd374eedf5a7a846942ce27a17bf7f5`, 2026-09-19 점검.

## 1. 사용자가 원하는 결과

- 사용하는 LLM에 관계없이 연결할 수 있는 법령 MCP. 일반 검색·원문 조회·결정례 조회에 서버의 LLM API 키를 요구하지 않는다.
- korean-law-mcp 공식 패키지를 별도 stdio 프로세스로 계속 사용한다. 소스를 복사하거나 포크하지 않고 검증된 업스트림 업데이트를 받는다.
- 법령·예규를 저장하는 데서 끝내지 않고, 최신 개정 및 사건 당시 적용 법령·부칙·관련 해석을 구분한다.
- 실패를 접수하면 재현 → 규칙/코드/테스트 패치 → 별도 AI 검수 → 필요한 재수정을 자동으로 진행한다. 준비된 PR을 모아 사람이 마지막에 검수하고 머지한다.
- 세법 외 노동법과 4대보험법도 같은 검색 기반에 포함한다. 전문 판정 규칙은 근거가 확보된 영역부터 늘린다.
- GCE·Supabase·Cloudflare 기존 구성을 이용한다. 검색 서비스와 개선 작업의 자원·예산을 분리한다. 한도 소진 시 개선 작업을 대기시키며 승인으로 처리하지 않는다.
- 키 교체는 이번 계획의 선행조건으로 삼지 않는다. 공개 HTTP는 수정한다.

## 2. 확인한 사실과 아직 확인하지 못한 것

| 구분 | 관찰 | 계획에 미치는 영향 |
|---|---|---|
| 리뷰 게이트 | 같은 HEAD에서 `npm run review`: 42개 중 27 통과, 15 실패 | All Pass라고 볼 수 없음. 14개는 새 MCP import를 테스트 VM이 제공하지 않아 본문 진입 전 실패 |
| 실제 upstream 시작 | 전체 실행에서는 10초 startup timeout 1개 실패. 해당 테스트 단독 실행은 통과 | 운영 결함으로 단정하지 않고 병렬 실행/자원 경쟁과 시간 예산을 분리 검증 |
| 실제 MCP | 원격 SSE 연결, 12개 도구 목록 및 근로기준법 검색 성공 | 조회 기반과 upstream stdio client는 유지 |
| 검증기 | FC-08/09/10에 해당하는 문장을 함께 넣어도 통과. 따옴표 없는 trigger는 실행되지 않음 | 자연어 YAML을 실행 규칙처럼 취급하는 구조를 교체 |
| 판정 범위 | `/api/analyze`는 전달된 draft 또는 query를 검사. 이후 LLM의 최종 답변까지 검사한 것은 아님 | 최종 초안과 검수 대상의 해시를 연결하고 미검수 상태를 명확히 표시 |
| AI 검수 | 입력은 issue와 fail_if뿐. 빈 응답/형식 오류/키 부재에 승인으로 이어지는 경로 존재 | correction, 실제 diff, 근거, 재현 결과를 함께 검수하고 불확실하면 대기 |
| 개선 PR | 실제 PR #1/#2 존재. 같은 유형의 제안이 중복되고 YAML 전체 재직렬화. 확인 당시 CI·리뷰 증거 없음 | PR 생성 기능과 검증된 자기수정 파이프라인을 구별 |
| 기록 | API key 주체는 `partner-agent` 문자열인데 DB는 auth UUID 요구. REST는 DB 반환 error를 무시하고 MCP 제안은 DB 기록 없음 | 공통 접수 서비스, 명시적 actor 매핑, DB-first/outbox 필요 |
| HTTPS | 로컬 tunnel 설정 및 DNS CNAME 존재. `https://law.taxlab.kr/health`는 확인 실패. 현재 bridge는 공개 HTTP | Linux tunnel·DNS proxy·원점 방화벽을 함께 확인해야 함 |
| 설치 | bridge 파일만 임시 빈 폴더로 옮겨 실행하면 SDK `ERR_MODULE_NOT_FOUND` | 패키지 의존성을 포함한 재현 가능한 설치 필요 |
| 배포 | PM2 tunnel 경로가 Windows 절대경로. cron 예제와 검증/rollback updater는 존재 | Linux용 배포 설정과 실제 cron 등록을 별도로 확인 |
| DB | 초기 SQL/RLS 로컬 테스트 통과. anon 요청은 테이블 권한 거부 | 기존 테이블 재생성이나 anon 권한 확대 대신 추가 migration |

실제 GCE VM의 계정·메모리·상주 프로세스·cron, Cloudflare connector 상태, 원격 AI 설정은 아직 확인하지 않았다. 기존 SSH 별칭이 대상 VM과 같다고 가정하지 않는다. 법률 결론 자체는 이 소프트웨어 점검으로 검증된 것이 아니다.

## 3. 목표 동작과 판정 계약

사용 흐름: 연결 확인 → 사건일/쟁점 입력 → 근거 조회 → 사용자의 LLM이 초안 작성 → 초안 검증 → 누락 사실 보완/재작성 → 검수 결과와 근거를 포함한 답변.

조회 도구는 계속 직접 사용할 수 있다. MCP의 안내만으로 모든 LLM이 검증 호출을 따르도록 강제할 수는 없다. 따라서 조회 응답을 `retrieval_only`로 표시하고, `validate_legal_draft`의 별도 결과만 검수 결과로 취급한다. 기존 `validate_tax_draft`는 호환 alias로 유지한다.

검수 결과는 단일 `passed` 대신 다음을 분리한다.

- `checks`: 각 규칙의 `pass | fail | needs_info | unverified | not_applicable | skipped`, 이유, 필요한 사실, 적용 근거.
- `scope`: 구조/산식/근거 존재/시점 일치/AI 의미 검토 중 실제 수행한 항목. 결정론적 통과가 전체 법률 결론의 보증은 아니다.
- `draft_hash`, `facts_hash`, `evidence_set_hash`, `rules_version`, `upstream_version`, 검사 시각과 유효 조건.
- `blocking_findings`와 `verification_complete`를 분리. skip/force/warn은 차단 정책만 바꾸며 검수 완료로 바꾸지 않는다.
- 미확인 사실, 적용일 미정, 원문 접근 실패, AI 미실행은 명시적으로 남긴다. 최종 답변 수정 시 이전 검수 해시는 유효하지 않다.

초안 검증은 서버 LLM 없이 구조·산식·확정된 규칙을 검사할 수 있어야 한다. 의미 해석이 필요한 항목은 근거와 구조화 사실을 요구하거나 미검수로 반환한다. 사용자 LLM이 제시한 사실/근거 역시 검증 대상이며 그 자체가 승인 증거는 아니다.

## 4. 구현 PR 구성과 의존성

### PR-0 — 테스트 게이트 복구와 공통 진입점 정리

대상: `src/index.ts`, `tests/review-regressions.test.mjs`, `tests/mcp-client.test.mjs`, 테스트 문서, CI.

- Express app 생성, REST/MCP transport, 인증·검증·개선 서비스와 listen/shutdown을 분리한다. 실제 서비스 함수를 DI해 테스트하며 TS를 VM으로 변환하는 import allowlist 결합을 없앤다.
- 14개 로딩 실패를 먼저 복구한다. 이후 노출되는 기존 assertion 실패는 제품 버그로 수정하거나 명시적으로 변경된 계약을 근거로 갱신한다. skip/단언 삭제로 통과시키지 않는다.
- deterministic gate는 외부 자격증명·유료 모델·실제 PR 생성 없이 동작한다. 공식 npm 패키지 startup smoke는 별도 제한시간/환경 조건으로 실행하며 CI 필수 결과로 남긴다.
- 인증, DB 오류, SSE/메시지 호출, 리소스 해제와 graceful shutdown까지 회귀 테스트한다. `scripts/test-pr.mjs`는 일반 검수/CI에서 제외한다.
- 검수 및 업데이트용 명령의 역할을 구분하고 CI에 연결한다. 테스트 통과 수는 결과에서 생성하여 문서의 고정된 All Pass 주장을 제거한다.

완료 기준: 오프라인 회귀 테스트가 모두 실행되어 통과, Linux/Windows startup smoke 통과, 네트워크/PR 생성 없는 일반 review. 실제 외부 통합 smoke는 따로 기록.

### PR-1 — HTTPS 전환과 설치·연결 사용성

의존: PR-0. 대상: bridge, 설치 스크립트, PM2/deploy 설정, README, MCP transport.

- 배포 대상 VM·tunnel UUID/connector·DNS의 proxy 상태를 확인하고 `https://law.taxlab.kr`를 유일한 기본 공개 주소로 설정한다. Linux cloudflared를 서비스로 관리하고 Windows 개발 설정을 분리한다.
- 원점은 loopback에 바인딩하고 GCE의 외부 3000 접근을 닫는다. 이 변경은 HTTPS health/실제 MCP 호출 및 기존 클라이언트 전환 확인 뒤 적용한다. rollback도 공개 HTTP 재개방 대신 이전 HTTPS 앱 버전으로 한다.
- API key/JWT를 헤더로 전송하고 URL query 인증을 제거한다. `/messages`도 재인증하여 생성한 세션의 actor와 결합한다. 세션 만료, 동시 연결 수, 요청 크기·timeout·429/Retry-After, 종료 정리를 적용한다.
- Streamable HTTP를 표준 원격 진입점으로 추가하고 기존 SSE는 호환 기간 동안 유지한다. 원격 인증을 직접 설정하기 어려운 클라이언트는 stdio bridge를 사용한다. OAuth가 필요한 클라이언트에 직접 연결 가능하다고 표기하지 않는다.
- bridge를 의존성이 포함된 버전 고정 npm 패키지로 설치한다. CLI에 `doctor`/연결 진단과 timeout, 제한된 재연결을 추가한다. 변경 요청의 무조건 재전송은 금지하고 idempotency key가 있는 요청만 안전하게 재시도한다.
- 설치기는 사용 클라이언트의 실제 설정 형식에 맞춰 병합하고 백업/복구 경로를 남긴다. Codex·Claude Desktop·Cursor 중 확인된 조합만 지원표에 적고 Hermes 등은 실제 연결 시험 후 표시한다. 필요 Node 버전도 통일한다.

완료 기준: 깨끗한 사용자 환경에서 설치→도구 목록→법령 조회 성공, 재시작 후 재연결, HTTPS 인증·세션 격리 테스트, 공개 HTTP 접근 불가, 설정 복구 성공.

### PR-2 — 근거·최신성·사건 시점 계약

의존: PR-0. 대상: 조회 응답 wrapper, source adapter, 근거 저장 migration, fixture.

- upstream 결과를 버리지 않고 `content`, `structuredContent`, `isError`를 보존한다. 별도 메타데이터에 source URL/기관/문서번호, 검색어, 조회시각, 원문 hash, 공포일/시행일/적용기간, upstream 버전, 확인 범위를 추가한다.
- `case_date`와 `as_of`를 구분한다. 현행·시행 예정·연혁을 혼동하지 않으며 부칙/경과조치 확인 여부를 별도 기록한다. 예규의 발행일만으로 현행 유효성을 확정하지 않는다.
- 문서 상태는 `verified_current | historical_match | changed | unavailable | unresolved` 등 실제 확인 수준을 나타낸다. 역사 버전 선택만으로 부칙 적용까지 검증됐다고 표시하지 않는다.
- 캐시는 TTL과 원문 식별자/버전을 함께 갖는다. 최종 검수 전 중요한 근거를 원 출처에 재확인하고, 접속 실패 시 마지막 정상 자료와 경과 시간을 제공하되 최신 확인 완료로 표시하지 않는다. 패키지 cron과 자료 최신성 확인을 분리한다.
- 법령·시행령·시행규칙·부칙 관계, 예규/판례의 변경·상충·후속 해석을 근거 묶음으로 표현한다. 폐기/대체 확인이 불가능한 기관 자료는 불확실성을 유지한다.
- 노동법과 4대보험은 기존 upstream 도구의 지원을 먼저 재사용하고 기관별 부족분만 adapter로 보완한다. paid scraping API는 필수가 아닌 fallback이며 quota/timeout/도메인 정책을 가진다.

완료 기준: 현행/미래 시행/과거 사건/부칙 미확인/예규 상충/출처 장애 fixture에서 상태가 구분됨. 조회시각이나 npm 최신 버전만으로 최신 법령이라고 판정하지 않음.

### PR-3 — 실행 가능한 검증 규칙과 FC-01~10 회귀

의존: PR-0, PR-2. 대상: gate engine, rule schema/catalog, 기존 YAML migration, validation 도구.

- 자연어 `trigger_condition`/`fail_if`는 설명으로 남기고 실행부는 Zod로 검증하는 제한된 선언형 조건/등록된 TypeScript 검사 함수로 정의한다. `all`/`any`, 사실 필수 여부, 비교/산식/합계 불변식과 적용 범위를 명시한다. YAML에서 임의 코드/표현식을 eval하지 않는다.
- 규칙마다 안정된 ID, 버전, 적용 법령·기간, 근거 ID, 양성/음성/누락 사실 fixture를 둔다. 파싱 실패/중복 ID/알 수 없는 연산자는 활성화하지 않고 마지막 정상 ruleset을 유지하며 degraded 상태를 알린다.
- FC-08/09/10은 소유자별 원가/지분/실제 분담금 부담/권리가액·시가·정산액/관리처분 전후를 분리해 입력받는다. 누락이면 `needs_info`. 합계 보존·이중계상 등 산술 검증과 논란 있는 법정 안분 결론은 분리한다.
- 기존 correction_prompt를 법률 정답으로 자동 승격하지 않는다. 해당 쟁점의 근거가 모자라면 `unverified`인 연구 과제로 유지한다. 문장 키워드만으로 특정 안분식을 정답으로 강제하지 않는다.
- 10개 기존 사례 각각에 트리거/위반/정상/부정문/인용/표현 변형/사실 부족을 검증한다. 한 규칙의 부정문이 다른 문장 위반까지 면제하지 않아야 한다. 모든 사례를 무조건 pass시키는 테스트는 금지한다.
- bypass는 사유와 rule ID를 기록한다. `force`나 `skip`한 규칙이 있으면 전체 검수 완료를 표시하지 않는다.

완료 기준: 기존 10개 사례의 평가 경로가 모두 존재하고 no-op 규칙이 없음. 법률 근거가 불충분한 사례는 명시적인 미검수/추가 사실 요청으로 나오며 잘못된 확정 판정을 하지 않음.

### PR-4 — 실패 접수·DB·작업 대기열을 하나로 연결

의존: PR-0, PR-2의 evidence 계약. 대상: REST/MCP 개선 서비스, 추가 Supabase migration, worker job API.

- API와 MCP가 동일한 `submit_failure` 서비스를 사용한다. DB에 접수/작업/outbox를 원자적으로 저장한 뒤 receipt ID와 `queued`를 반환한다. DB 저장 실패면 접수 성공이나 PR 링크를 반환하지 않는다.
- `profiles`와 `auth.users`는 그대로 유지한다. 별도 `actors` UUID 테이블에 `auth_user`와 `api_client`를 구분하고 신뢰할 수 있는 서버 설정/검증된 JWT에서 actor를 결정한다. 기존 키는 하나의 공유 actor이며 개인 식별·개인별 비밀 격리를 보장하지 않는다고 명시한다. proposer_name은 표시용이다.
- `evolution_logs`는 추가 migration으로 actor, failure/job/evidence, patch SHA, AI 결과와 진행 상태를 참조하게 확장한다. 기존 user FK를 backfill 후 전환하며 제안자 단독 승인/머지를 계속 금지한다. 개인 JWT는 자기 기록만 읽고, 공유 key actor는 해당 공유 범위만 접근한다.
- DB 쓰기는 서버 전용 경로로 수행하고 caller가 actor/status를 임의 지정할 수 없게 한다. anon grant를 열지 않는다. privileged DB 자격증명은 API/worker에만 두며 생성된 패치 실행 환경으로 전달하지 않는다. RLS와 서버 권한검사를 모두 테스트한다.
- idempotency는 actor+요청 ID, 의미 중복 탐지는 정규화한 실패 signature+규칙/근거 버전을 사용한다. 같은 문제가 반복되면 기존 작업에 빈도/새 증거를 추가한다. 서로 다른 사건의 민감한 내용은 병합하거나 노출하지 않는다.
- DB 상태와 GitHub 원격 작업은 outbox/reconciler로 연결한다. PR 생성 성공 후 DB 실패/worker crash/재시도 시 correlation ID로 기존 PR을 찾아 연결한다. 성공을 숨기거나 중복 PR을 만들지 않는다.
- 상태 예: `queued → reproducing → patching → testing → ai_review → revision_required → ready_for_human → merged → deployed`; quota/외부 장애는 `waiting_dependency`, 재현 불가·근거 부족은 `needs_evidence`, 상한 초과는 `exhausted`.
- failure 원본/사건 자료는 비공개 DB에 최소한으로 보관하고 보존기한을 둔다. 공개 GitHub PR에는 익명화한 최소 재현, synthetic fixture와 공개 출처만 내보낸다. 자동 공개 검사를 통과하지 못하면 대기한다.

완료 기준: API/MCP 동일 결과, RLS/actor 위조 거부, DB 실패·PR 성공 후 crash·재요청에서 중복 없는 복구, 키 없는 GitHub 연동은 명시적 미설정 상태이며 mock URL을 성공으로 반환하지 않음.

### PR-5 — 자동 패치·독립 AI 검수·재수정 루프

의존: PR-2, PR-3, PR-4. 대상: worker, reviewer adapter, job 상태 전이, PR 생성.

- 사용자 LLM과 무관한 선택형 maintenance worker가 작업을 처리한다. 실서비스 GCE에서는 HTTP/MCP·가벼운 queue polling만 운영하고, 패치 생성/테스트는 격리된 CI 또는 이미 확보한 개발 머신 worker에서 수행한다. 특정 유료 API·새 VM 구매를 필수로 하지 않는다.
- 작성자 agent는 실제 실패 fixture를 먼저 만들고 현재 버전 실패 → 패치 버전 통과를 기록한다. rules뿐 아니라 `src`/tests의 결함도 수정할 수 있게 하되 작업 범위/시간/파일 제한을 둔다.
- 패치 실행은 운영 토큰 없는 임시 작업공간에서 한다. GitHub 게시·DB 기록은 별도 trusted coordinator가 담당한다. 외부 법령/실패 문서는 데이터로 취급하며 명령·도구 권한으로 해석하지 않는다.
- reviewer는 작성자와 별도 세션/호출로 수행하고 base/head SHA, diff, correction, 출처/적용일, 재현 전후 로그, 회귀 결과를 받는다. 모델/provider/설정, 입력 hash, verdict, 이유와 요구 수정사항을 보관한다.
- verdict는 Zod enum으로 엄격 검증한다. 빈 응답, `"false"` 문자열, 형식 오류, HTTP 실패, timeout, 키/예산 부재는 승인으로 취급하지 않는다. `approved | changes_requested | needs_evidence | unavailable`를 구분한다.
- 수정 요청은 같은 작업·브랜치에 반영하고 재검증한다. 기본 자동 시도 3회, 작업/일 단위 토큰·시간·비용 상한과 지수 backoff를 둔다. 상한 초과는 보류하며 무한 PR 생성·무한 재시도하지 않는다.
- AI 승인은 head SHA+근거/ruleset fingerprint에 묶는다. 새 commit, base 변경으로 인한 재base, 중요한 출처 변경 때 무효화한다. 사람이 검수할 준비가 되었다는 상태와 사람의 최종 승인을 구분한다.

완료 기준: 의도적 코드 버그와 규칙 버그 각 1건에 대해 실패→패치→독립 reviewer 수정 요청→재수정→준비 완료 E2E. provider 장애/예산 소진 시 ready_for_human으로 오르지 않음. 서버 LLM 키가 없어도 일반 법령 조회는 정상.

### PR-6 — PR 일괄 검수·머지·배포 및 upstream cron

의존: PR-1~5. 대상: GitHub workflows, batch manifest, deploy/updater 설정, 운영 안내.

- 자동 생성 제안은 Draft PR로 관리하고 준비된 것만 검수 묶음에 올린다. 규칙을 개별 파일로 나누고 manifest로 읽어 YAML 전체 덤프 충돌을 줄인다. 파싱 실패 시 기존 규칙을 새 빈 구조로 대체하지 않는다.
- 묶음 화면/문서는 PR별 실패 내용, 수정 범위, 재현 전후, 근거·최신성 상태, AI 검수, CI, 정확한 head SHA를 한 곳에 보여준다. 초기에는 GitHub의 batch PR/체크 보고서를 이용하고 별도 웹 UI는 필수로 만들지 않는다.
- 같은 base 위에 선택한 PR들을 통합한 batch candidate를 만들고 합쳐진 상태에서 전체 회귀/규칙 충돌/DB 호환을 검사한다. 사람은 이 묶음의 정확한 SHA를 마지막에 승인·머지한다. 구성 PR/head/base 변경 시 다시 검수 대상으로 표시한다.
- CI는 읽기 권한을 기본으로 하고, PR의 비신뢰 코드를 실행하는 job에 운영 secrets를 넣지 않는다. 생성 agent는 main에 직접 push/merge/deploy하지 않는다. production deploy는 사람 승인된 merge SHA로만 수행한다.
- 배포는 immutable release + health/MCP smoke + 이전 앱/rules/upstream 버전 rollback. SQL은 추가·하위호환 migration을 우선 적용하고 앱 rollback만으로 DB를 되돌렸다고 주장하지 않는다. DB 복구/forward-fix 절차를 별도로 기록한다.
- 기존 upstream updater의 후보 설치→review/smoke→atomic switch→health→rollback/lock/journal/logrotate를 유지한다. Linux 실제 cron 등록, 재부팅 후 동작, lock 경쟁, 실패 알림을 검증한다. 우리 코드의 사람 승인 배포와 upstream 버전 교체는 별도 경로다.
- upstream 도구 schema/출력/법령 fixture의 계약 변화는 자동 활성화하지 않고 검토 대상으로 보류한다. cron 실패 시 이전 정상 버전으로 조회 서비스를 유지한다.

완료 기준: 충돌하는 두 PR의 묶음 검증이 실패, 정상 두 PR의 정확한 묶음 SHA를 사람이 승인한 뒤만 배포 가능. 재base로 승인 무효화. 배포 실패 자동 rollback, cron 실패 이전 upstream 유지. 공개 PR에 원본 사건 자료/토큰 없음.

## 5. 순서·운영 한도·출시 기준

작업 순서: PR-0 → PR-1 및 PR-2 → PR-3 및 PR-4 → PR-5 → PR-6. PR들은 모아 최종 검수할 수 있지만, 기반 수정의 diff/테스트 의존성을 명시한다. HTTPS 긴급 전환이 필요하면 별도 최소 배포 후보로 분리한다.

GCE에서 별도 브라우저 크롤러·패치 빌드·LLM 추론을 상주시킨다는 가정은 하지 않는다. 초기 검색 동시성 3을 유지하되 실측 메모리/응답시간으로 확정하고, 개선 worker 동시성은 1로 시작한다. 연결 수·queue 길이·보관량·원문 크기·로그 용량에도 상한을 둔다. 비용이나 서비스 quota가 모자라면 지연/대기로 처리하고 계정 증설로 제한을 우회하지 않는다.

출시 검수의 핵심은 다음 네 가지다.

1. 새 컴퓨터에서 MCP 연결·검색이 되고 HTTPS로만 통신한다.
2. 안 했거나 못한 검사를 통과로 표시하지 않으며 법령 시점과 출처를 확인할 수 있다.
3. 실패 1건이 기록·재현·코드/규칙 수정·독립 검수·재수정을 거쳐 하나의 검수 가능한 PR이 된다.
4. 여러 PR을 모아 사람 한 번의 최종 검수 후 정확한 검증 버전만 배포하고 복구할 수 있다.

## 6. 독립 검수에 요청하는 판단

이 계획이 목표를 달성하는지, 불필요한 확장인지, 수정 순서/마이그레이션/실패 복구/무료 자원 제약에서 빠진 조건이 있는지 검토한다. 특히 공유 API key actor와 RLS, 공개 PR의 사건 정보 유출 방지, 선택형 초안 검증의 한계, 법률 근거의 불확실성, 외부 AI 검수 실패 시 상태, SHA에 묶인 사람의 일괄 승인, upstream 자동 업데이트와 검증 무효화를 비판적으로 검수한다.

실제 코드 수정 완료나 법률 내용의 적법성 승인을 요청하는 것이 아니다. 제공된 사실/코드의 확인 범위를 넘어서 테스트·서버 확인을 수행했다고 주장하지 않아야 한다.


## Baseline source: src/index.ts

   1: import express, { Request, Response, NextFunction } from "express";
   2: import dotenv from "dotenv";
   3: import { verifyWithSupremeJudge } from "./supremeJudge.js";
   4: import { createAutoPR } from "./gitOps.js";
   5: import { createClient } from "@supabase/supabase-js";
   6: import * as fs from "fs";
   7: import * as path from "path";
   8: import * as yaml from "js-yaml";
   9: import { z } from "zod";
  10: import { createKoreanLawClient, LawMcpError } from "./koreanLawClient.js";
  11: import { Server } from "@modelcontextprotocol/sdk/server/index.js";
  12: import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
  13: import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
  14: 
  15: dotenv.config();
  16: 
  17: const app = express();
  18: app.use(express.json());
  19: const koreanLaw = createKoreanLawClient();
  20: 
  21: // Initialize Global Supabase Client
  22: const supabaseUrl = process.env.SUPABASE_URL || "https://placeholder.supabase.co";
  23: const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "placeholder_key";
  24: 
  25: // [P1 Fix] Concurrency Limiter - Prevent double decrement
  26: let currentConcurrentRequests = 0;
  27: const MAX_CONCURRENT_REQUESTS = 3;
  28: 
  29: const concurrencyLimiter = (req: Request, res: Response, next: NextFunction) => {
  30:   if (currentConcurrentRequests >= MAX_CONCURRENT_REQUESTS) {
  31:     return res.status(429).json({ error: "Server is at max capacity. Please try again later." });
  32:   }
  33:   currentConcurrentRequests++;
  34:   
  35:   let isDecremented = false;
  36:   const decrement = () => {
  37:     if (!isDecremented) {
  38:       currentConcurrentRequests--;
  39:       isDecremented = true;
  40:     }
  41:   };
  42: 
  43:   res.on("finish", decrement);
  44:   res.on("close", decrement);
  45:   next();
  46: };
  47: 
  48: // Check both Supabase JWT token and direct API Key
  49: const verifyAuth = async (req: Request): Promise<{ authorized: boolean; user?: any; supabaseClient?: any }> => {
  50:   const authHeader = req.headers.authorization;
  51:   const apiKeyHeader = req.headers["x-api-key"] as string | undefined;
  52:   const queryApiKey = req.query.apiKey as string | undefined;
  53:   const expectedKey = process.env.TAXLAB_API_KEY || "[REDACTED_SHARED_KEY]";
  54: 
  55:   // Check API Key
  56:   if (apiKeyHeader === expectedKey || queryApiKey === expectedKey) {
  57:     return {
  58:       authorized: true,
  59:       user: { id: "partner-agent", email: "partner@taxlab.kr" },
  60:     };
  61:   }
  62:   if (authHeader?.startsWith("Bearer ") && authHeader.slice(7) === expectedKey) {
  63:     return {
  64:       authorized: true,
  65:       user: { id: "partner-agent", email: "partner@taxlab.kr" },
  66:     };
  67:   }
  68: 
  69:   // Check Supabase Bearer Token
  70:   const token = authHeader?.split(" ")[1];
  71:   if (token) {
  72:     const globalSupabase = createClient(supabaseUrl, supabaseKey);
  73:     const { data: { user }, error } = await globalSupabase.auth.getUser(token);
  74:     if (!error && user) {
  75:       const userScopedClient = createClient(supabaseUrl, supabaseKey, {
  76:         global: { headers: { Authorization: `Bearer ${token}` } }
  77:       });
  78:       return { authorized: true, user, supabaseClient: userScopedClient };
  79:     }
  80:   }
  81: 
  82:   return { authorized: false };
  83: };
  84: 
  85: // [P1 Fix] Auth Middleware: Supports both Supabase JWT and TAXLAB_API_KEY
  86: const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  87:   const auth = await verifyAuth(req);
  88:   if (!auth.authorized) {
  89:     return res.status(401).json({ error: "Unauthorized. Missing or invalid Bearer Token or X-API-KEY." });
  90:   }
  91:   (req as any).user = auth.user;
  92:   (req as any).supabaseAuthClient = auth.supabaseClient;
  93:   next();
  94: };
  95: 
  96: // [P1 Fix] YAML Validation Pipeline with Negation & Bypass Support
  97: export interface GateValidationOptions {
  98:   skipGates?: string[];
  99:   mode?: "strict" | "warn";
 100:   force?: boolean;
 101: }
 102: 
 103: export interface GateValidationResult {
 104:   passed: boolean;
 105:   blocked: boolean;
 106:   triggered_gate?: string;
 107:   correction?: string | null;
 108:   warnings?: Array<{ id: string; name: string; correction: string }>;
 109: }
 110: 
 111: const isNegatedStatement = (text: string, keyword: string): boolean => {
 112:   const index = text.indexOf(keyword);
 113:   if (index === -1) return false;
 114:   const followingText = text.slice(index + keyword.length, index + keyword.length + 45);
 115:   const precedingText = text.slice(Math.max(0, index - 25), index);
 116:   const negationPattern = /(안\s*되|않|금지|불가|배제|제외|아닙|아님|해서는\s*안|하면\s*안|할\s*수\s*없|오류|잘못|주의|피해야|분리)/i;
 117:   const precedingNegation = /(금지|불가|제외|배제|하면\s*안)/i;
 118:   return negationPattern.test(followingText) || precedingNegation.test(precedingText);
 119: };
 120: 
 121: const validateDraftWithQualityGates = (
 122:   draftAnswer: string,
 123:   options?: GateValidationOptions
 124: ): GateValidationResult => {
 125:   try {
 126:     const filePath = path.join(process.cwd(), "fail-cases.yaml");
 127:     if (!fs.existsSync(filePath)) {
 128:       throw new Error("fail-cases.yaml is missing on the server.");
 129:     }
 130:     
 131:     const yamlContent = fs.readFileSync(filePath, "utf-8");
 132:     const parsed: any = yaml.load(yamlContent);
 133:     
 134:     if (!parsed || !parsed.gates || !Array.isArray(parsed.gates)) {
 135:       throw new Error("Invalid format in fail-cases.yaml");
 136:     }
 137: 
 138:     const skipSet = new Set(options?.skipGates || []);
 139:     const warnings: Array<{ id: string; name: string; correction: string }> = [];
 140: 
 141:     // Evaluate Gates dynamically
 142:     for (const gate of parsed.gates) {
 143:       if (skipSet.has(gate.id)) {
 144:         continue; // Skip bypassed gate (False Positive Escape Hatch)
 145:       }
 146: 
 147:       const triggerMatches = [...(gate.trigger_condition.matchAll(/'([^']+)'/g) || [])];
 148:       const triggerKeywords = triggerMatches.map(m => m[1]);
 149:       
 150:       const isTriggered = triggerKeywords.length > 0 && triggerKeywords.every(kw => draftAnswer.includes(kw));
 151: 
 152:       if (isTriggered) {
 153:         let isFailed = false;
 154:         
 155:         // Relaxed match for test flexibility with Context-aware Negation Guard
 156:         if (gate.id === "QG-TIME-03" && (draftAnswer.includes("계약일") || draftAnswer.includes("잔금일")) && draftAnswer.includes("통일")) {
 157:           if (!isNegatedStatement(draftAnswer, "통일")) {
 158:             isFailed = true;
 159:           }
 160:         } else if (gate.id === "QG-COST-01" && draftAnswer.includes("자동 가산")) {
 161:           if (!isNegatedStatement(draftAnswer, "자동 가산")) {
 162:             isFailed = true;
 163:           }
 164:         } else if (draftAnswer.includes("오류") || draftAnswer.includes("무조건")) {
 165:           if (!isNegatedStatement(draftAnswer, "무조건") && !isNegatedStatement(draftAnswer, "오류")) {
 166:             isFailed = true;
 167:           }
 168:         }
 169: 
 170:         if (isFailed) {
 171:           warnings.push({ id: gate.id, name: gate.name, correction: gate.correction_prompt });
 172:           const isWarnOnly = options?.mode === "warn" || options?.force === true;
 173:           if (!isWarnOnly) {
 174:             return {
 175:               passed: false,
 176:               blocked: true,
 177:               triggered_gate: gate.id,
 178:               correction: gate.correction_prompt,
 179:               warnings,
 180:             };
 181:           }
 182:         }
 183:       }
 184:     }
 185:     
 186:     return {
 187:       passed: warnings.length === 0,
 188:       blocked: false,
 189:       triggered_gate: warnings[0]?.id,
 190:       correction: warnings[0]?.correction ?? null,
 191:       warnings,
 192:     };
 193:   } catch (e: any) {
 194:     throw new Error(`YAML Quality Gate Evaluation Failed: ${e.message}`);
 195:   }
 196: };
 197: 
 198: app.get("/health", (req, res) => {
 199:   res.status(200).json({ status: "ok", active_requests: currentConcurrentRequests, mcp_release: koreanLaw.releaseVersion ?? null });
 200: });
 201: 
 202: // [P2 Fix] Input Validation Schemas
 203: const AnalyzeRequestSchema = z.object({
 204:   query: z.string().trim().min(1, "Query is required").max(20_000),
 205:   tool: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128).default("legal_research"),
 206:   arguments: z.record(z.unknown()).default({}),
 207:   draft_answer: z.string().trim().min(1).max(50_000).optional(),
 208:   skip_gates: z.array(z.string()).max(50).optional(),
 209:   mode: z.enum(["strict", "warn"]).default("strict"),
 210:   force: z.boolean().default(false),
 211: }).strict();
 212: 
 213: const EvolveRequestSchema = z.object({
 214:   issue_summary: z.string().trim().min(1, "Issue summary is required").max(20_000),
 215:   proposed_fail_if: z.string().trim().min(1, "Proposed fail condition is required").max(20_000),
 216:   correction_prompt: z.string().trim().min(1, "Correction prompt is required").max(20_000)
 217: });
 218: 
 219: const respondWithAnalyzeError = (res: Response, error: unknown) => {
 220:   if (error instanceof z.ZodError) return res.status(400).json({ error: error.errors });
 221:   if (error instanceof LawMcpError) {
 222:     return res.status(error.status).json({ error: error.message, code: error.code, result: error.result });
 223:   }
 224:   return res.status(500).json({ error: error instanceof Error ? error.message : "Legal retrieval failed." });
 225: };
 226: 
 227: // Expose the installed upstream's tool schemas so any caller can select tools.
 228: app.get("/api/tools", concurrencyLimiter, requireAuth, async (_req: Request, res: Response) => {
 229:   try {
 230:     res.json({ status: "success", data: await koreanLaw.listTools() });
 231:   } catch (error) {
 232:     respondWithAnalyzeError(res, error);
 233:   }
 234: });
 235: 
 236: // Legal retrieval is model-independent: the calling LLM writes the final answer.
 237: app.post("/api/analyze", concurrencyLimiter, requireAuth, async (req: Request, res: Response) => {
 238:   try {
 239:     const validatedData = AnalyzeRequestSchema.parse(req.body);
 240:     const { query, tool, arguments: args, draft_answer, skip_gates, mode, force } = validatedData;
 241: 
 242:     // Preserve the legacy query gate; callers can explicitly submit their draft.
 243:     // Enhanced with False-Positive bypass (skip_gates) and soft warning modes.
 244:     const validationResult = validateDraftWithQualityGates(draft_answer ?? query, {
 245:       skipGates: skip_gates,
 246:       mode,
 247:       force,
 248:     });
 249: 
 250:     if (validationResult.blocked) {
 251:        return res.status(400).json({ 
 252:          error: "Quality Gate Failed", 
 253:          gate_id: validationResult.triggered_gate,
 254:          correction_prompt: validationResult.correction,
 255:          warnings: validationResult.warnings ?? [],
 256:        });
 257:     }
 258: 
 259:     const toolArgs = { ...args };
 260:     if (["legal_research", "search_law", "search_decisions"].includes(tool)) {
 261:       toolArgs.query = query;
 262:     }
 263:     const data = await koreanLaw.callTool(tool, toolArgs);
 264:     res.json({ 
 265:       status: "success", 
 266:       data, 
 267:       quality_gate: { 
 268:         passed: validationResult.passed, 
 269:         blocked: false,
 270:         warnings: validationResult.warnings ?? [],
 271:         checked: draft_answer ? "draft_answer" : "query" 
 272:       } 
 273:     });
 274:   } catch (error) {
 275:     respondWithAnalyzeError(res, error);
 276:   }
 277: });
 278: 
 279: // Phase 4: Evolve Pipeline [P1 Fix: Added concurrencyLimiter]
 280: app.post("/api/evolve", concurrencyLimiter, requireAuth, async (req: Request, res: Response) => {
 281:   try {
 282:     const validatedData = EvolveRequestSchema.parse(req.body);
 283:     const { issue_summary, proposed_fail_if, correction_prompt } = validatedData;
 284:     
 285:     const user = (req as any).user;
 286:     const authClient = (req as any).supabaseAuthClient; // Scoped Client for RLS
 287: 
 288:     // 1. Supreme Judge Verification
 289:     const isApproved = await verifyWithSupremeJudge(issue_summary, proposed_fail_if);
 290:     if (!isApproved) {
 291:       return res.status(400).json({ status: "rejected", message: "Rule rejected by Supreme Judge." });
 292:     }
 293: 
 294:     // 2. GitHub API (Octokit) Auto-PR Generation
 295:     const prUrl = await createAutoPR(proposed_fail_if, correction_prompt, user.id);
 296: 
 297:     // 3. Log to Supabase using User-Scoped Client or Global Client
 298:     const dbClient = authClient || createClient(supabaseUrl, supabaseKey);
 299:     try {
 300:       await dbClient.from("evolution_logs").insert([{ 
 301:         proposer_id: user.id || "partner-agent", 
 302:         pr_url: prUrl, 
 303:         status: "pending_human_review",
 304:         rule_content: proposed_fail_if,
 305:         issue_summary,
 306:         correction_prompt,
 307:       }]);
 308:     } catch (dbError) {
 309:       console.warn("⚠️ [Evolution Log] Supabase logging warning (non-fatal):", dbError);
 310:     }
 311: 
 312:     res.json({ status: "success", pr_url: prUrl });
 313:   } catch (error: any) {
 314:     if (error instanceof z.ZodError) {
 315:       return res.status(400).json({ error: error.errors });
 316:     }
 317:     res.status(500).json({ error: error.message });
 318:   }
 319: });
 320: 
 321: // ==========================================
 322: // Remote MCP (SSE) Architecture & Handlers
 323: // ==========================================
 324: const sseTransports = new Map<string, SSEServerTransport>();
 325: 
 326: function createTaxMcpServer() {
 327:   const mcpServer = new Server(
 328:     { name: "taxlab-legal-harness", version: "2.1.0" },
 329:     { capabilities: { tools: {} } }
 330:   );
 331: 
 332:   mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
 333:     const upstream = await koreanLaw.listTools();
 334:     const customTools = [
 335:       {
 336:         name: "validate_tax_draft",
 337:         description: "검증툴: 세법 답변 초안을 fail-cases.yaml의 10대 세법 함정에 대조하여 사전 검증합니다. 오탐 방지용 바이패스(skip_gates) 및 경고 모드를 지원합니다.",
 338:         inputSchema: {
 339:           type: "object",
 340:           properties: {
 341:             draft_answer: { type: "string", description: "검증할 세법 답변 초안 본문" },
 342:             query: { type: "string", description: "원래 질문 (선택 사항)" },
 343:             skip_gates: {
 344:               type: "array",
 345:               items: { type: "string" },
 346:               description: "오탐(False Positive) 방지: 건너뛸 게이트 ID 목록 (예: ['QG-COST-01'])",
 347:             },
 348:             mode: {
 349:               type: "string",
 350:               enum: ["strict", "warn"],
 351:               description: "strict: 실패 시 차단, warn: 실패하더라도 차단하지 않고 경고 반환",
 352:             },
 353:             force: {
 354:               type: "boolean",
 355:               description: "true일 경우 게이트 통과를 강제하고 경고만 메타데이터로 남김",
 356:             },
 357:           },
 358:           required: ["draft_answer"],
 359:         },
 360:       },
 361:       {
 362:         name: "propose_tax_rule",
 363:         description: "발전툴: 새로운 세법 함정이나 계산 오류 케이스를 발견했을 때 규칙 제안. 대법관(Supreme Judge) 검증 통과 시 GitHub(hyunae52/legal_harness)에 자동으로 PR을 생성합니다.",
 364:         inputSchema: {
 365:           type: "object",
 366:           properties: {
 367:             issue_summary: { type: "string", description: "세법 오류/함정 사례 요약" },
 368:             proposed_fail_if: { type: "string", description: "오류 판정 조건 (fail_if 패턴)" },
 369:             correction_prompt: { type: "string", description: "수정 지침 및 올바른 법리 설명" },
 370:             proposer_name: { type: "string", description: "제안자 이름 (예: hermes, partner-agent)" },
 371:           },
 372:           required: ["issue_summary", "proposed_fail_if", "correction_prompt"],
 373:         },
 374:       },
 375:     ];
 376: 
 377:     return {
 378:       tools: [...upstream.tools, ...customTools],
 379:     };
 380:   });
 381: 
 382:   mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
 383:     const { name, arguments: args } = request.params;
 384: 
 385:     if (name === "validate_tax_draft") {
 386:       const draft = String(args?.draft_answer || "");
 387:       const query = String(args?.query || "");
 388:       const skipGates = Array.isArray(args?.skip_gates) ? (args?.skip_gates as string[]) : undefined;
 389:       const mode = args?.mode === "warn" ? "warn" : "strict";
 390:       const force = Boolean(args?.force);
 391: 
 392:       const result = validateDraftWithQualityGates(draft || query, { skipGates, mode, force });
 393:       return {
 394:         content: [
 395:           {
 396:             type: "text",
 397:             text: JSON.stringify({
 398:               passed: result.passed,
 399:               blocked: result.blocked,
 400:               triggered_gate: result.triggered_gate ?? null,
 401:               correction_directive: result.correction ?? null,
 402:               warnings: result.warnings ?? [],
 403:               message: result.passed
 404:                 ? "✅ 품질 게이트 통과: 감지된 세법 함정이 없습니다."
 405:                 : result.blocked
 406:                 ? `⚠️ 품질 게이트 실패: [수정 지침] ${result.correction}`
 407:                 : `ℹ️ 품질 게이트 경고(우회됨): [지침] ${result.correction}`,
 408:             }, null, 2),
 409:           },
 410:         ],
 411:       };
 412:     }
 413: 
 414:     if (name === "propose_tax_rule") {
 415:       const issue_summary = String(args?.issue_summary || "");
 416:       const proposed_fail_if = String(args?.proposed_fail_if || "");
 417:       const correction_prompt = String(args?.correction_prompt || "");
 418:       const proposer_name = String(args?.proposer_name || "hermes-agent");
 419: 
 420:       const isApproved = await verifyWithSupremeJudge(issue_summary, proposed_fail_if);
 421:       if (!isApproved) {
 422:         return {
 423:           content: [{ type: "text", text: JSON.stringify({ status: "rejected", message: "Rule rejected by Supreme Judge." }) }],
 424:           isError: true,
 425:         };
 426:       }
 427: 
 428:       const prUrl = await createAutoPR(proposed_fail_if, correction_prompt, proposer_name);
 429:       return {
 430:         content: [
 431:           {
 432:             type: "text",
 433:             text: JSON.stringify({
 434:               status: "approved",
 435:               pr_url: prUrl,
 436:               message: "대법관 검증 통과 및 GitHub Auto-PR 생성 성공!",
 437:             }, null, 2),
 438:           },
 439:         ],
 440:       };
 441:     }
 442: 
 443:     // Forward to upstream korean-law-mcp
 444:     const toolArgs = { ...(args || {}) } as Record<string, unknown>;
 445:     const response = await koreanLaw.callTool(name, toolArgs);
 446:     return {
 447:       content: response.result.content,
 448:       isError: response.result.isError,
 449:     };
 450:   });
 451: 
 452:   return mcpServer;
 453: }
 454: 
 455: // Remote MCP SSE Endpoints (for Claude Desktop, Cursor, Hermes on Ubuntu)
 456: app.get("/sse", async (req: Request, res: Response) => {
 457:   const auth = await verifyAuth(req);
 458:   if (!auth.authorized) {
 459:     return res.status(401).json({ error: "Unauthorized. Provide ?apiKey= or x-api-key header." });
 460:   }
 461: 
 462:   const transport = new SSEServerTransport("/messages", res);
 463:   const mcpServer = createTaxMcpServer();
 464: 
 465:   sseTransports.set(transport.sessionId, transport);
 466:   res.on("close", () => {
 467:     sseTransports.delete(transport.sessionId);
 468:     void mcpServer.close();
 469:   });
 470: 
 471:   await mcpServer.connect(transport);
 472: });
 473: 
 474: app.post("/messages", async (req: Request, res: Response) => {
 475:   const sessionId = req.query.sessionId as string;
 476:   if (!sessionId) {
 477:     return res.status(400).json({ error: "Missing sessionId query parameter." });
 478:   }
 479:   const transport = sseTransports.get(sessionId);
 480:   if (!transport) {
 481:     return res.status(404).json({ error: "Session not found or expired." });
 482:   }
 483:   await transport.handlePostMessage(req, res, req.body);
 484: });
 485: 
 486: const PORT = process.env.PORT || 3000;
 487: const server = app.listen(PORT, () => {
 488:   console.error(`🚀 K-Tax Express Server running on port ${PORT}`);
 489: });
 490: 
 491: let shuttingDown = false;
 492: const shutdown = async () => {
 493:   if (shuttingDown) return;
 494:   shuttingDown = true;
 495:   const deadline = setTimeout(() => {
 496:     server.closeAllConnections();
 497:     process.exit(1);
 498:   }, 10_000);
 499:   deadline.unref();
 500:   await Promise.all([
 501:     new Promise<void>(resolve => server.close(() => resolve())),
 502:     koreanLaw.close(),
 503:   ]);
 504:   clearTimeout(deadline);
 505: };
 506: process.once("SIGINT", () => { void shutdown(); });
 507: process.once("SIGTERM", () => { void shutdown(); });

## Baseline source: src/supremeJudge.ts

   1: import dotenv from "dotenv";
   2: 
   3: dotenv.config();
   4: 
   5: /**
   6:  * Supreme Judge Verification Module
   7:  * Evaluates a proposed tax Quality Gate rule against legal principles.
   8:  * Supports:
   9:  * 1. Google Gemini API (gemini-2.5-pro, gemini-2.0-flash, etc.) via GEMINI_API_KEY
  10:  * 2. OpenAI / DeepSeek / OpenRouter / Local Ollama via OPENAI_API_KEY (+ optional OPENAI_BASE_URL)
  11:  * 3. Anthropic Claude (Claude 3.7 Sonnet, etc.) via ANTHROPIC_API_KEY
  12:  * 4. Offline heuristic fallback if no key is configured
  13:  */
  14: export async function verifyWithSupremeJudge(
  15:   issueSummary: string,
  16:   proposedFailIf: string
  17: ): Promise<boolean> {
  18:   console.error("⚖️  [Supreme Judge] Reviewing proposed rule...");
  19:   console.error(`⚖️  [Supreme Judge] Issue: ${issueSummary}`);
  20:   console.error(`⚖️  [Supreme Judge] Proposed Condition: ${proposedFailIf}`);
  21: 
  22:   // Basic sanity check: tax rules cannot be absolute unconditional assertions
  23:   if (proposedFailIf.includes("무조건")) {
  24:     console.error("⚖️  [Supreme Judge] REJECTED: Tax law cannot contain unconditional absolutes ('무조건').");
  25:     return false;
  26:   }
  27: 
  28:   const systemPrompt = `You are the Supreme Tax Law Quality Judge (대법관).
  29: Your role is to rigorously review whether a proposed Quality Gate rule for a tax assistant agent is legally sound and prevents common tax reasoning failures.
  30: Return strictly a JSON object: {"approved": true|false, "reason": "brief explanation"}.`;
  31: 
  32:   const userPrompt = `Tax Issue: ${issueSummary}\nProposed Rule (fail_if): ${proposedFailIf}\nIs this legally reasonable to enforce as an automated guardrail?`;
  33: 
  34:   // 1. Google Gemini API (Recommended: Generous free limits and strong Korean reasoning)
  35:   if (process.env.GEMINI_API_KEY) {
  36:     try {
  37:       const model = process.env.SUPREME_JUDGE_MODEL || "gemini-2.0-flash";
  38:       const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  39:       
  40:       const response = await fetch(url, {
  41:         method: "POST",
  42:         headers: { "Content-Type": "application/json" },
  43:         body: JSON.stringify({
  44:           systemInstruction: { parts: [{ text: systemPrompt }] },
  45:           contents: [{ parts: [{ text: userPrompt }] }],
  46:           generationConfig: { responseMimeType: "application/json" },
  47:         }),
  48:       });
  49: 
  50:       if (response.ok) {
  51:         const result: any = await response.json();
  52:         const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  53:         const parsed = JSON.parse(text);
  54:         console.error(`⚖️  [Supreme Judge - Gemini (${model})] Decision: ${parsed.approved ? "APPROVED" : "REJECTED"} (${parsed.reason || "No reason given"})`);
  55:         return Boolean(parsed.approved);
  56:       }
  57:       console.warn("⚠️  [Supreme Judge] Gemini API error status:", response.status);
  58:     } catch (err: any) {
  59:       console.warn("⚠️  [Supreme Judge] Failed to call Gemini API:", err.message);
  60:     }
  61:   }
  62: 
  63:   // 2. OpenAI / DeepSeek / OpenRouter / Groq / Ollama (OpenAI-compatible)
  64:   if (process.env.OPENAI_API_KEY) {
  65:     try {
  66:       const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  67:       const model = process.env.SUPREME_JUDGE_MODEL || "gpt-4o";
  68:       
  69:       const response = await fetch(`${baseUrl}/chat/completions`, {
  70:         method: "POST",
  71:         headers: {
  72:           Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  73:           "Content-Type": "application/json",
  74:         },
  75:         body: JSON.stringify({
  76:           model,
  77:           response_format: { type: "json_object" },
  78:           messages: [
  79:             { role: "system", content: systemPrompt },
  80:             { role: "user", content: userPrompt },
  81:           ],
  82:         }),
  83:       });
  84: 
  85:       if (response.ok) {
  86:         const result: any = await response.json();
  87:         const parsed = JSON.parse(result.choices?.[0]?.message?.content || '{"approved": true}');
  88:         console.error(`⚖️  [Supreme Judge - OpenAI/Compatible (${model})] Decision: ${parsed.approved ? "APPROVED" : "REJECTED"}`);
  89:         return Boolean(parsed.approved);
  90:       }
  91:       console.warn("⚠️  [Supreme Judge] OpenAI/Compatible API error status:", response.status);
  92:     } catch (err: any) {
  93:       console.warn("⚠️  [Supreme Judge] Failed to call OpenAI/Compatible API:", err.message);
  94:     }
  95:   }
  96: 
  97:   // 3. Anthropic API Call
  98:   if (process.env.ANTHROPIC_API_KEY) {
  99:     try {
 100:       const model = process.env.SUPREME_JUDGE_MODEL || "claude-3-7-sonnet-20250219";
 101:       const response = await fetch("https://api.anthropic.com/v1/messages", {
 102:         method: "POST",
 103:         headers: {
 104:           "x-api-key": process.env.ANTHROPIC_API_KEY,
 105:           "anthropic-version": "2023-06-01",
 106:           "content-type": "application/json",
 107:         },
 108:         body: JSON.stringify({
 109:           model,
 110:           max_tokens: 300,
 111:           system: systemPrompt,
 112:           messages: [{ role: "user", content: userPrompt }],
 113:         }),
 114:       });
 115: 
 116:       if (response.ok) {
 117:         const result: any = await response.json();
 118:         const text = result.content?.[0]?.text || "";
 119:         const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{"approved": true}');
 120:         console.error(`⚖️  [Supreme Judge - Anthropic (${model})] Decision: ${parsed.approved ? "APPROVED" : "REJECTED"} (${parsed.reason || "No reason given"})`);
 121:         return Boolean(parsed.approved);
 122:       }
 123:       console.warn("⚠️  [Supreme Judge] Anthropic API error status:", response.status);
 124:     } catch (err: any) {
 125:       console.warn("⚠️  [Supreme Judge] Failed to call Anthropic API:", err.message);
 126:     }
 127:   }
 128: 
 129:   // 4. Fallback Heuristic
 130:   console.error("⚖️  [Supreme Judge] Running in offline heuristic mode (No LLM API key detected).");
 131:   const isReasonableLength = proposedFailIf.trim().length >= 10 && issueSummary.trim().length >= 5;
 132:   return isReasonableLength;
 133: }

## Baseline source: src/gitOps.ts

   1: import { Octokit } from "@octokit/rest";
   2: import dotenv from "dotenv";
   3: import * as yaml from "js-yaml";
   4: 
   5: dotenv.config();
   6: 
   7: export interface AutoPROptions {
   8:   owner?: string;
   9:   repo?: string;
  10:   baseBranch?: string;
  11: }
  12: 
  13: export async function createAutoPR(
  14:   proposedFailIf: string,
  15:   correctionPrompt: string,
  16:   proposerId: string,
  17:   options?: AutoPROptions
  18: ): Promise<string> {
  19:   const token = process.env.GITHUB_TOKEN;
  20:   const owner = options?.owner || process.env.GITHUB_OWNER || "simdorei";
  21:   const repo = options?.repo || process.env.GITHUB_REPO || "legal_harness";
  22:   const baseBranch = options?.baseBranch || process.env.GITHUB_BASE_BRANCH || "main";
  23: 
  24:   if (!token) {
  25:     console.warn("⚠️  [GitOps] GITHUB_TOKEN is not set. Falling back to mock PR URL for testing.");
  26:     return `https://github.com/${owner}/${repo}/pull/mock-${Date.now()}`;
  27:   }
  28: 
  29:   const octokit = new Octokit({ auth: token });
  30:   const timestamp = Date.now();
  31:   const branchName = `auto-evolve-${timestamp}`;
  32:   const ruleId = `QG-AUTO-${timestamp}`;
  33: 
  34:   console.error(`🚀 [GitOps] Creating branch '${branchName}' from '${baseBranch}' on ${owner}/${repo}...`);
  35: 
  36:   // 1. Get SHA of the base branch
  37:   const { data: baseRef } = await octokit.rest.repos.getBranch({
  38:     owner,
  39:     repo,
  40:     branch: baseBranch,
  41:   });
  42:   const baseSha = baseRef.commit.sha;
  43: 
  44:   // 2. Create new branch ref
  45:   await octokit.rest.git.createRef({
  46:     owner,
  47:     repo,
  48:     ref: `refs/heads/${branchName}`,
  49:     sha: baseSha,
  50:   });
  51: 
  52:   // 3. Get existing fail-cases.yaml
  53:   let fileSha: string | undefined;
  54:   let currentContent = "";
  55:   try {
  56:     const { data: fileData } = await octokit.rest.repos.getContent({
  57:       owner,
  58:       repo,
  59:       path: "fail-cases.yaml",
  60:       ref: branchName,
  61:     });
  62: 
  63:     if ("content" in fileData && !Array.isArray(fileData)) {
  64:       fileSha = fileData.sha;
  65:       currentContent = Buffer.from(fileData.content, "base64").toString("utf-8");
  66:     }
  67:   } catch (err: any) {
  68:     if (err.status !== 404) throw err;
  69:   }
  70: 
  71:   // 4. Append new rule to YAML structure
  72:   let parsedYaml: any = { gates: [] };
  73:   if (currentContent.trim()) {
  74:     try {
  75:       const loaded: any = yaml.load(currentContent);
  76:       if (loaded && Array.isArray(loaded.gates)) {
  77:         parsedYaml = loaded;
  78:       }
  79:     } catch (e) {
  80:       console.error("Failed to parse existing YAML, initializing fresh structure.");
  81:     }
  82:   }
  83: 
  84:   const newGate = {
  85:     id: ruleId,
  86:     name: `Crowdsourced Rule by ${proposerId}`,
  87:     source_case: `EVOLVE-${timestamp}`,
  88:     trigger_condition: `주제 == '자동제안' AND '${proposerId}'`,
  89:     fail_if: proposedFailIf,
  90:     correction_prompt: correctionPrompt,
  91:   };
  92: 
  93:   parsedYaml.gates.push(newGate);
  94:   const updatedYamlContent = yaml.dump(parsedYaml, { indent: 2, lineWidth: -1 });
  95: 
  96:   // 5. Commit updated fail-cases.yaml to new branch
  97:   await octokit.rest.repos.createOrUpdateFileContents({
  98:     owner,
  99:     repo,
 100:     path: "fail-cases.yaml",
 101:     message: `feat(harness): auto-propose rule ${ruleId} by ${proposerId}`,
 102:     content: Buffer.from(updatedYamlContent).toString("base64"),
 103:     sha: fileSha,
 104:     branch: branchName,
 105:   });
 106: 
 107:   // 6. Create Pull Request
 108:   const prTitle = `[Auto-Evolve] Rule Proposal ${ruleId} (${proposerId})`;
 109:   const prBody = `### 🤖 Autonomous Quality Gate Proposal
 110: - **Proposer:** \`${proposerId}\`
 111: - **Rule ID:** \`${ruleId}\`
 112: - **Violated Pattern (fail_if):**
 113:   > ${proposedFailIf}
 114: - **Correction Directive:**
 115:   > ${correctionPrompt}
 116: 
 117: ---
 118: *Generated by K-Tax Agent Supreme Judge Pipeline. Please review and merge to activate this rule.*`;
 119: 
 120:   const { data: pr } = await octokit.rest.pulls.create({
 121:     owner,
 122:     repo,
 123:     title: prTitle,
 124:     head: branchName,
 125:     base: baseBranch,
 126:     body: prBody,
 127:   });
 128: 
 129:   console.error(`✅ [GitOps] Successfully opened PR: ${pr.html_url}`);
 130:   return pr.html_url;
 131: }

## Baseline source: fail-cases.yaml

   1: # fail-cases.yaml
   2: # Hermes 에이전트의 실패 사례(FC-01 ~ FC-10)를 기반으로 작성된 구조화된 Quality Gate 데이터
   3: 
   4: gates:
   5:   - id: QG-COST-01
   6:     name: "재산분할 취득세 취득원가 중복/오류 방지"
   7:     source_case: "FC-01"
   8:     trigger_condition: "취득원인 == '이혼 재산분할' AND '취득세' 언급됨"
   9:     fail_if: "재산분할 시점의 취득세를 양도소득세 새 취득원가에 자동 가산함"
  10:     correction_prompt: "재산분할 취득분은 전 배우자의 당초 취득시기/가액을 승계합니다. 재산분할 시점에 새로 낸 취득세는 취득원가에서 제외하고 재계산하세요."
  11: 
  12:   - id: QG-TIME-03
  13:     name: "부당행위계산부인 시점 분리"
  14:     source_case: "FC-02"
  15:     trigger_condition: "주제 == '부당행위계산부인' AND '특수관계인'"
  16:     fail_if: "부당행위 해당성 판단시점과 법정 평가기간(시가)을 동일한 날짜(잔금일 또는 계약일)로 통일함"
  17:     correction_prompt: "부당행위 해당성은 '계약일', 시가자료 평가기간은 '양도일 전후 3개월'로 기준시점을 분리하여 다시 작성하세요."
  18: 
  19:   - id: QG-EXCEPTION-02
  20:     name: "거주요건 별도 판정 (직전거주주택)"
  21:     source_case: "FC-03"
  22:     trigger_condition: "주제 == '직전거주주택보유주택'"
  23:     fail_if: "조문 명칭('거주주택')만 보고 거주하지 않은 주택의 특례 적용을 전면 부정함"
  24:     correction_prompt: "해당성과 거주요건을 분리하십시오. 기재부/국세청 해석례(예: 재산세제과-1081)를 검색하여 재판단하세요."
  25: 
  26:   - id: QG-VALUATION-01
  27:     name: "개인-법인 간 거래 특칙"
  28:     source_case: "FC-04"
  29:     trigger_condition: "거래당사자 중 '법인' 포함 AND '부당행위계산' 또는 '감정가액'"
  30:     fail_if: "상증세법 평가규정(10억 초과 2감정)만 적용하고 법인세법 시행령 제89조 특칙을 누락함"
  31:     correction_prompt: "법인세법 시행령 제89조 제2항 제1호를 준용하여 감정가액 1곳도 가능한지 다시 판단하세요."
  32: 
  33:   - id: QG-PRECEDENT-03
  34:     name: "상속재산 대상분할 정산금 재원 확인"
  35:     source_case: "FC-05"
  36:     trigger_condition: "주제 == '상속재산 대상분할' AND '정산금 지급'"
  37:     fail_if: "정산금 재원을 확인하지 않고 민법 소급효만으로 '양도 아님'으로 확정함"
  38:     correction_prompt: "정산금 재원이 고유자금인지 상속재산인지 확인하고, 국세청 예규와 조세판결(과세 입장)을 병렬 제시하세요."
  39: 
  40:   - id: QG-FACT-02
  41:     name: "추계신고 경정청구 납세자 일반화 방지"
  42:     source_case: "FC-06"
  43:     trigger_condition: "주제 == '추계신고' AND '장부 경정청구'"
  44:     fail_if: "납세자 유형(간편장부/복식부기)을 구분하지 않고 경정청구가 가능하다고 일반화함"
  45:     correction_prompt: "납세자가 간편장부대상자인지 복식부기의무자인지 구분하여 결론을 다시 작성하세요."
  46: 
  47:   - id: QG-TIME-02
  48:     name: "과거 예규 요건 현행 적용 방지 (Version Drift)"
  49:     source_case: "FC-07"
  50:     trigger_condition: "과거 예규 인용 AND '보유' 또는 '거주' 요건 명시"
  51:     fail_if: "과거 예규 작성 당시의 숫자(예: 3년 보유)를 현행 사안에 그대로 복사함"
  52:     correction_prompt: "인용된 예규 당시의 조문과 현행 조문(예: 2년 보유)을 비교하고, 부칙 적용례에 맞춰 현행 요건으로 수정하세요."
  53: 
  54:   - id: QG-COST-02
  55:     name: "타인 원가 합산 방지"
  56:     source_case: "FC-08"
  57:     trigger_condition: "소유자 2인 이상 AND 종전 취득원가 안분"
  58:     fail_if: "서로 다른 소유자의 취득원가를 합산한 뒤 권리가액 비율로 재분배함"
  59:     correction_prompt: "각 소유자(owner_id)별로 독립된 취득원가 버킷을 생성하여 계산하고 합산을 금지하세요."
  60: 
  61:   - id: QG-COST-03
  62:     name: "공동부담 분담금 몰아주기 방지"
  63:     source_case: "FC-09"
  64:     trigger_condition: "추가분담금/청산금 존재 AND 소유자 2인 이상"
  65:     fail_if: "자산 귀속만 보고 특정 소유자의 원가에 분담금 전액을 가산함"
  66:     correction_prompt: "실제 부담자와 부담 비율을 확인하여 공동부담액을 분할 가산하세요."
  67: 
  68:   - id: QG-MATH-01
  69:     name: "법정 안분기준 임의 교체 방지"
  70:     source_case: "FC-10"
  71:     trigger_condition: "안분 계산 (종전권리가액, 신축주택가액 존재)"
  72:     fail_if: "법정 안분기준을 '시가'나 '경제적 지분'으로 임의 대체하여 계산함"
  73:     correction_prompt: "직관적 경제 지분이 아닌 법정 안분산식에 맞춰 변수(종전권리가액, 분담금 등)를 엄격히 적용하세요."

## Baseline source: supabase/migrations/202609140001_profiles_evolution_logs.sql

   1: -- Run once in Supabase SQL Editor or through `supabase db push`.
   2: -- Supabase owns auth.users; passwords/tokens do not belong in public tables.
   3: begin;
   4: 
   5: create table public.profiles (
   6:   id uuid primary key references auth.users(id) on delete cascade,
   7:   display_name text not null default '' check (char_length(display_name) <= 120),
   8:   created_at timestamptz not null default now(),
   9:   updated_at timestamptz not null default now()
  10: );
  11: 
  12: create table public.evolution_logs (
  13:   id uuid primary key default gen_random_uuid(),
  14:   proposer_id uuid not null references auth.users(id) on delete cascade,
  15:   issue_summary text not null check (char_length(btrim(issue_summary)) between 1 and 20000),
  16:   rule_content text not null check (char_length(btrim(rule_content)) between 1 and 20000),
  17:   correction_prompt text not null check (char_length(btrim(correction_prompt)) between 1 and 20000),
  18:   pr_url text not null check (pr_url ~ '^https://[^[:space:]]+$'),
  19:   status text not null default 'pending_human_review'
  20:     check (status in ('pending_human_review', 'approved', 'rejected', 'merged')),
  21:   reviewed_by uuid references auth.users(id) on delete set null,
  22:   reviewed_at timestamptz,
  23:   review_note text,
  24:   created_at timestamptz not null default now(),
  25:   updated_at timestamptz not null default now()
  26: );
  27: 
  28: create index evolution_logs_proposer_created_idx
  29:   on public.evolution_logs (proposer_id, created_at desc);
  30: create index evolution_logs_pending_idx
  31:   on public.evolution_logs (created_at)
  32:   where status = 'pending_human_review';
  33: 
  34: create function public.legal_harness_set_updated_at()
  35: returns trigger language plpgsql set search_path = '' as $$
  36: begin
  37:   new.updated_at = now();
  38:   return new;
  39: end;
  40: $$;
  41: 
  42: create trigger profiles_set_updated_at before update on public.profiles
  43: for each row execute function public.legal_harness_set_updated_at();
  44: create trigger evolution_logs_set_updated_at before update on public.evolution_logs
  45: for each row execute function public.legal_harness_set_updated_at();
  46: 
  47: create function public.legal_harness_handle_new_user()
  48: returns trigger language plpgsql security definer set search_path = '' as $$
  49: begin
  50:   insert into public.profiles (id, display_name)
  51:   values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 120));
  52:   return new;
  53: end;
  54: $$;
  55: 
  56: create trigger legal_harness_auth_user_created after insert on auth.users
  57: for each row execute function public.legal_harness_handle_new_user();
  58: 
  59: -- Also create profiles for users registered before this migration.
  60: insert into public.profiles (id, display_name)
  61: select id, left(coalesce(raw_user_meta_data ->> 'display_name', ''), 120)
  62: from auth.users;
  63: 
  64: alter table public.profiles enable row level security;
  65: alter table public.evolution_logs enable row level security;
  66: 
  67: -- Override Supabase's default table grants before granting only needed columns.
  68: revoke all on public.profiles, public.evolution_logs from public, anon, authenticated;
  69: grant select on public.profiles to authenticated;
  70: grant update (display_name) on public.profiles to authenticated;
  71: grant select on public.evolution_logs to authenticated;
  72: grant insert (proposer_id, issue_summary, rule_content, correction_prompt, pr_url, status)
  73:   on public.evolution_logs to authenticated;
  74: grant all on public.profiles, public.evolution_logs to service_role;
  75: 
  76: create policy profiles_select_own on public.profiles
  77: for select to authenticated using ((select auth.uid()) = id);
  78: create policy profiles_update_own on public.profiles
  79: for update to authenticated
  80: using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
  81: 
  82: create policy evolution_logs_select_own on public.evolution_logs
  83: for select to authenticated using ((select auth.uid()) = proposer_id);
  84: create policy evolution_logs_insert_own_pending on public.evolution_logs
  85: for insert to authenticated with check (
  86:   (select auth.uid()) = proposer_id
  87:   and status = 'pending_human_review'
  88:   and reviewed_by is null and reviewed_at is null and review_note is null
  89: );
  90: 
  91: -- Review outcomes are updated by the trusted reviewer/backend, never by a
  92: -- proposer JWT. A pending row is a submission, not proof of AI/human approval.
  93: revoke all on function public.legal_harness_set_updated_at() from public, anon, authenticated;
  94: revoke all on function public.legal_harness_handle_new_user() from public, anon, authenticated;
  95: 
  96: comment on table public.evolution_logs is
  97:   'Patch submissions. Final approval/merge requires trusted review; client-created rows are not attestations of AI review.';
  98: 
  99: commit;
