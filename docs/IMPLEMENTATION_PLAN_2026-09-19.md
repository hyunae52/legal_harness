# Legal Harness 수정 계획

후속 상태: 구현 후 받은 Pro 응답에 따른 남은 작업 순서는 [2026-09-20 남은 구현·운영 전환 계획](REMAINING_PLAN_2026-09-20.md)에서 관리한다. 아래 내용과 초기 시험 수치는 2026-09-19 계획 당시의 기록이다.

상태: v2.1 — GPT-6 Pro 2차 검수의 “조건부 구현 착수 가능” 판정 후 잔여 문구 두 곳을 수정한 최종 계획. 구현·배포·머지는 아직 수행하지 않음. [검수 기록](reviews/PRO_REVIEW_2026-09-19.md), [v1 제출본](reviews/PRO_REVIEW_PACKET_2026-09-19_v1.md).

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

- `checks`: 각 규칙의 `pass | fail | needs_info | unverified | not_applicable | skipped`, 이유, 필요한 사실, 적용 근거. 필수 검사 집합은 서버의 버전 관리된 정책이 결정한다. 적용 여부 불명은 `needs_info`이며 적용 조건이 거짓임을 확인했을 때만 `not_applicable`이다.
- `scope`: 구조/산식/근거 존재/시점 일치/AI 의미 검토 중 실제 수행한 항목. 결정론적 통과가 전체 법률 결론의 보증은 아니다.
- `draft_hash`, `facts_hash`, `evidence_set_hash`, `rules_version`, `upstream_version`, 검사 시각과 유효 조건.
- `blocking_findings`, `assessment_complete`, `scoped_pass`를 분리한다. `assessment_complete`는 필수 검사 전부가 실제 평가되었다는 뜻이며 실패 판정과 공존할 수 있다. `scoped_pass`는 정의된 비어 있지 않은 필수 검사 집합에서 미확인/우회/실패가 없을 때만 true다. 평가 규칙 0개는 `no_coverage`로 표시한다. skip/force/warn은 차단 정책만 바꾸며 검수 완료·통과를 만들지 않는다.
- 미확인 사실, 적용일 미정, 원문 접근 실패, AI 미실행은 명시적으로 남긴다. 최종 답변 수정 시 이전 검수 해시는 유효하지 않다.

초안 검증은 서버 LLM 없이 구조·산식·확정된 규칙을 검사할 수 있어야 한다. 의미 해석이 필요한 항목은 근거와 구조화 사실을 요구하거나 미검수로 반환한다. 사용자 LLM이 제시한 사실/근거 역시 검증 대상이며 그 자체가 승인 증거는 아니다. facts의 산식 검사와 초안 본문에 적힌 숫자·주장의 일치 검사는 별도 항목이다. 본문 일치를 검사하지 않았으면 해당 범위는 `unverified`다. 검수 receipt는 서버만 발급하며 입력 해시 외 검사 정책 버전·실행 묶음 fingerprint에 결합한다. REST/MCP/alias는 같은 엄격한 Zod schema를 사용하고 문자열을 Boolean/String으로 임의 변환하지 않는다.

## 4. 구현 PR 구성과 의존성

### PR-0 — 테스트 게이트 복구와 공통 진입점 정리

대상: `src/index.ts`, `tests/review-regressions.test.mjs`, `tests/mcp-client.test.mjs`, 테스트 문서, CI.

- Express app 생성, REST/MCP transport, 인증·검증·개선 서비스와 listen/shutdown을 분리한다. 실제 서비스 함수를 DI해 테스트하며 TS를 VM으로 변환하는 import allowlist 결합을 없앤다.
- 14개 로딩 실패를 먼저 복구한다. 이후 노출되는 기존 assertion 실패는 제품 버그로 수정하거나 명시적으로 변경된 계약을 근거로 갱신한다. skip/단언 삭제로 통과시키지 않는다.
- deterministic gate는 외부 자격증명·유료 모델·실제 PR 생성 없이 동작한다. 공식 npm 패키지 startup smoke는 별도 제한시간/환경 조건으로 실행하며 CI 필수 결과로 남긴다.
- 인증, DB 오류, SSE/메시지 호출, 리소스 해제와 graceful shutdown까지 회귀 테스트한다. `scripts/test-pr.mjs`는 일반 검수/CI에서 제외한다.
- 검수 및 업데이트용 명령의 역할을 구분하고 CI에 연결한다. 테스트 통과 수는 결과에서 생성하여 문서의 고정된 All Pass 주장을 제거한다.
- 첫 안전 버전에서는 구형 `/api/evolve`와 `propose_tax_rule`의 직접 PR 생성·휴리스틱 승인 경로를 비활성화한다. 새 접수/검수 경로 완성 전에는 명시적 `maintenance_unavailable`을 반환한다. 새 경로를 alias로 연결한 뒤만 활성화한다. 이 버전을 rollback 최저 버전으로 삼고, 이후 인증 수정도 반영된 안전 release를 복구 대상으로 지정한다.
- 신뢰된 필수 검사 목록과 최종 집계기를 먼저 둔다. 필수 job의 누락/skip/neutral/cancelled, 다른 head나 다른 생산자의 결과는 성공으로 집계하지 않는다. 자동 패치로 집계기·기존 회귀 테스트를 삭제하거나 약화시키는 변경은 일반 자동 수정 대상에서 제외한다.

완료 기준: 오프라인 회귀 테스트가 모두 실행되어 통과, Linux/Windows startup smoke 통과, 네트워크/PR 생성 없는 일반 review. 실제 외부 통합 smoke는 따로 기록.

### PR-1 — HTTPS 긴급 전환과 최소 연결 경로

의존: PR-0. 대상: bridge, 설치 스크립트, PM2/deploy 설정, README, MCP transport.

- 배포 대상 VM·tunnel UUID/connector·DNS의 proxy 상태를 확인하고 `https://law.taxlab.kr`를 유일한 기본 공개 주소로 설정한다. Linux cloudflared를 서비스로 관리하고 Windows 개발 설정을 분리한다.
- 원점은 loopback에 바인딩하고 GCE의 외부 3000 접근을 닫는다. HTTPS health/인증된 실제 MCP 호출 및 최소 bridge 전환을 확인한 같은 배포 창에서 차단한다. 모든 예전 클라이언트 전환을 무기한 기다리지 않으며 미전환 클라이언트는 명확한 재설정 안내를 받는다. rollback도 공개 HTTP 재개방 대신 이전 안전 HTTPS 앱 버전으로 한다.
- API key/JWT를 헤더로 전송하고 URL query 인증을 제거한다. `/messages`도 재인증하여 생성한 세션의 actor와 결합한다. 세션 만료, 동시 연결 수, 요청 크기·timeout·429/Retry-After, 종료 정리를 적용한다.
- 기존 공유 key는 환경설정으로 사용할 수 있지만 hardcoded fallback은 제거한다. key 설정 누락 시 해당 인증을 거부한다. 키 교체와는 별개다.
- 1차는 현재 SSE+stdio bridge 경로 하나를 완성한다. 원격 인증을 직접 설정하기 어려운 클라이언트는 stdio bridge를 사용하며 OAuth가 필요한 클라이언트의 직접 연결을 지원한다고 표시하지 않는다. Streamable HTTP는 뒤의 작은 호환 PR로 분리하고 추가 시 Origin 검증·인증·세션 경계 시험을 필수로 한다.
- bridge를 의존성이 포함된 버전 고정 npm 패키지로 설치한다. CLI에 `doctor`/연결 진단과 timeout, 제한된 재연결을 추가한다. 변경 요청의 무조건 재전송은 금지하고 idempotency key가 있는 요청만 안전하게 재시도한다.
- 1차는 버전 고정 패키지와 실제 시험한 클라이언트의 설정 예제/연결 진단으로 제공한다. 다중 클라이언트 설정 자동 병합은 별도 후속 범위다. 기존 설치기를 수정할 때는 기존 설정의 백업·복구를 제공한다. 확인한 조합만 지원표에 적고 필요 Node 버전도 통일한다.

완료 기준: 깨끗한 사용자 환경에서 설치→도구 목록→법령 조회 성공, 재시작 후 재연결, query 인증/키 누락/다른 actor의 세션 사용 거부, 공개 HTTP 접근 불가, 설정 복구 성공. 두 개의 서로 다른 MCP 클라이언트에서 표준 stdio 연결을 시험하되 여러 종류의 자동 설치기 완성을 기다리지 않는다.

### PR-2 — 근거·최신성·사건 시점 계약

의존: PR-4의 actor/저장 기반. 최소 evidence envelope 타입은 PR-0에서 먼저 고정한다. 대상: 조회 응답 wrapper, source adapter, fixture.

- upstream 결과를 버리지 않고 `content`, `structuredContent`, `isError`를 보존한다. 별도 메타데이터에 source URL/기관/문서번호, 검색어, 조회시각, 원문 hash, 공포일/시행일/적용기간, upstream 버전, 확인 범위를 추가한다.
- `as_of`와 사건의 역할별 날짜(계약일, 양도 관련 일자, 관리처분 관련 일자, 과세기간 등)를 구분한다. 해당 규칙에 필요한 날짜만 요구한다. 현행·시행 예정·연혁을 혼동하지 않으며 예규 발행일만으로 현행 유효성을 확정하지 않는다.
- 단일 문서 상태로 합치지 않고 원문 접근(`available/unavailable`), 버전 선택(`current/historical/future/unresolved`), 사건 적용·부칙 확인(`confirmed/needs_info/unverified`), 후속 해석 확인 수준을 각각 기록한다. 과거 버전이 확보됐지만 현재 원문 재확인에 실패한 상태도 표현할 수 있어야 한다.
- 캐시는 TTL과 원문 식별자/버전을 함께 갖는다. 최종 검수 전 중요한 근거를 원 출처에 재확인하고, 접속 실패 시 마지막 정상 자료와 경과 시간을 제공하되 최신 확인 완료로 표시하지 않는다. 패키지 cron과 자료 최신성 확인을 분리한다.
- 1차는 요청과 규칙에 실제 필요한 법령·시행령·시행규칙·부칙 및 해석의 근거 묶음만 확보한다. 전 기관 상시 수집이나 전체 예규 변경 그래프는 후속 범위다. 폐기/대체 확인이 불가능한 기관 자료는 불확실성을 유지한다.
- 노동법과 4대보험은 기존 upstream 도구의 지원을 먼저 재사용하고 기관별 부족분만 adapter로 보완한다. paid scraping API는 필수가 아닌 fallback이며 quota/timeout/도메인 정책을 가진다.

완료 기준: 현행/미래 시행/과거 사건/부칙 미확인/예규 상충/출처 장애 fixture에서 상태가 구분됨. 조회시각이나 npm 최신 버전만으로 최신 법령이라고 판정하지 않음.

### PR-3 — 실행 가능한 검증 규칙과 FC-01~10 회귀

의존: PR-0, PR-2. 대상: gate engine, rule schema/catalog, 기존 YAML migration, validation 도구.

- 자연어 `trigger_condition`/`fail_if`는 설명으로 남기고 실행부는 등록된 TypeScript 검사 함수와 Zod metadata로 정의한다. 사실 필수 여부, 비교/산식/합계 불변식과 적용 범위를 명시한다. 1차에 범용 규칙 언어를 만들지 않고 YAML에서 임의 코드/표현식을 eval하지 않는다.
- 이 PR에서 규칙을 안정된 ID의 개별 파일과 manifest로 나눈다. 이후 자동 작성자는 개별 규칙만 수정한다. 전체 YAML 재직렬화와 파싱 실패 시 빈 구조 재생성을 제거한다.
- 규칙마다 안정된 ID, 버전, 적용 법령·기간, 근거 ID, 양성/음성/누락 사실 fixture를 둔다. 파싱 실패/중복 ID/알 수 없는 연산자는 활성화하지 않고 마지막 정상 ruleset을 유지하며 degraded 상태를 알린다.
- FC-08/09/10은 소유자별 원가/지분/실제 분담금 부담/권리가액·시가·정산액/관리처분 전후를 분리해 입력받는다. 누락이면 `needs_info`. 합계 보존·이중계상 등 산술 검증과 논란 있는 법정 안분 결론은 분리한다.
- 기존 correction_prompt를 법률 정답으로 자동 승격하지 않는다. 해당 쟁점의 근거가 모자라면 `unverified`인 연구 과제로 유지한다. 문장 키워드만으로 특정 안분식을 정답으로 강제하지 않는다.
- 10개 기존 사례 각각에 트리거/위반/정상/부정문/인용/표현 변형/사실 부족을 검증한다. 한 규칙의 부정문이 다른 문장 위반까지 면제하지 않아야 한다. 모든 사례를 무조건 pass시키는 테스트는 금지한다.
- bypass는 사유와 rule ID를 기록한다. 필수 규칙을 skip하여 미실행했으면 `assessment_complete=false`다. force/warn은 실제 검사 결과와 평가 완료 여부를 바꾸지 않고 차단 정책만 변경한다. 우회가 있으면 `scoped_pass=false`다.

완료 기준: 기존 10개 사례의 평가 경로가 모두 존재하고 no-op 규칙이 없음. 법률 근거가 불충분한 사례는 명시적인 미검수/추가 사실 요청으로 나오며 잘못된 확정 판정을 하지 않음. 빈 초안, 검사 0개, 전부 skip, `"false"` 문자열, facts/본문 불일치, AI 미실행, 검수 후 초안 변경을 모든 진입점에서 동일하게 시험한다.

### PR-4 — 실패 접수·DB·작업 대기열을 하나로 연결

의존: PR-0 및 PR-1. PR-0의 최소 evidence envelope 타입만 요구하며 전체 자료 수집 구현을 기다리지 않는다. 대상: REST/MCP 개선 서비스, 추가 Supabase migration, worker job API.

- API와 MCP가 동일한 `submit_failure` 서비스를 사용한다. 하나의 Postgres 트랜잭션/RPC로 failure/job/outbox를 함께 저장한 뒤 receipt ID와 `queued`를 반환한다. Supabase INSERT 세 번을 순서대로 호출하는 방식은 금지한다. DB 저장 실패면 접수 성공이나 PR 링크를 반환하지 않는다.
- `profiles`와 `auth.users`는 그대로 유지한다. 별도 `actors` UUID 테이블에 `auth_user`와 `api_client`를 구분하고 신뢰할 수 있는 서버 설정/검증된 JWT에서 actor를 결정한다. 기존 키는 하나의 공유 actor이며 개인 식별·개인별 비밀 격리를 보장하지 않는다고 명시한다. proposer_name은 표시용이다.
- 기존 `evolution_logs`의 필수 proposer/rule/correction/PR URL 제약을 억지로 queued에 맞추지 않는다. 과거 기록으로 보존하고 새 `failures`, `jobs`, `outbox`, 근거/검수 기록 테이블을 expand-only로 추가한다. 실패 접수는 수정안이나 PR URL이 없어도 가능해야 한다. 가짜 Auth 사용자나 mock URL을 만들지 않는다.
- `actors`에는 UUID PK, `kind`, 종류별 user UUID 또는 서버 등록 client ID를 두고 CHECK/UNIQUE로 잘못된 조합과 중복을 차단한다. JWT 사용자는 자기 비공개 기록을 조회하고, 공유 key 경로는 공개 가능한 구조화 제안/상태만 허용한다. 공유 key에 개인 사건 원문 접근을 맡기지 않는다.
- 기존 `authenticated`의 evolution_logs 직접 INSERT grant/policy를 폐쇄하고 과거 자기 기록 조회 및 profiles 트리거는 유지한다. 새 테이블도 기본 grant를 회수하고 grants/RLS를 함께 정의한다. 서버의 privileged DB 쓰기는 trusted coordinator만 수행하고 actor/status는 검증된 요청·상태 전이에서 결정한다. service_role 경로를 RLS가 자동 격리한다고 가정하지 않고 서버 권한검사를 별도로 시험한다.
- 제안 JWT·API key·작성 agent는 승인/머지 상태를 만들 수 없다. 같은 사람이 신고자이면서 운영자인 1인 운영은 허용하되, 최종 승인은 별도의 운영자 GitHub 동작으로 증명한다.
- idempotency는 actor+요청 ID+요청 내용 hash에 묶고 같은 ID에 다른 내용이면 409로 거부한다. 의미 중복 탐지는 정규화한 실패 signature+규칙/근거 버전을 사용한다. 같은 문제가 반복되면 기존 작업에 빈도/새 증거를 추가하되 서로 다른 사건의 민감한 내용을 병합하거나 노출하지 않는다.
- outbox는 작업별 고정 branch/correlation ID와 외부 operation intent를 전송 전에 저장한다. 응답 유실은 `unknown`으로 남긴다. 조회 결과 없음만으로 미전송을 확정하지 않고 기존 PR 한 개에 수렴하거나 보류한다. 미확정 상태에서 새 PR·ready_for_human을 만들지 않는다.
- lease 소유자와 단조 증가 attempt/fencing 번호를 DB 상태 갱신 조건으로 검사한다. 오래된 worker의 결과는 거부한다. 외부 쓰기는 coordinator만 수행하며 lease 변경 후 이전 작업자는 직접 게시할 수 없다. 재시작해도 시도/예산 카운터를 초기화하지 않는다.
- 상태 예: `queued → reproducing → patching → testing → ai_review → revision_required → ready_for_human → merged → deployed`; quota/외부 장애는 `waiting_dependency`, 재현 불가·근거 부족은 `needs_evidence`, 상한 초과는 `exhausted`.
- 반출 순서를 `비공개 접수 → 허용 필드로 합성한 공개 재현자료 → 동일 실패 재현 확인 → 작성/검수 → 전체 공개 산출물 검사 → 최초 push/PR`로 고정한다. 원본 자유서술의 완벽한 자동 익명화를 전제하지 않는다. 합성만으로 재현되지 않으면 `needs_evidence`로 대기한다.
- 공개 자료 검사 범위는 모든 commit·diff·파일명·PR 제목/본문·stdout·CI artifact·check summary·reviewer 응답을 포함한다. 외부 AI에도 공개 가능한 패킷만 보낸다. 자유서술 원문을 넣어야 하는 작업은 이 자동 경로에서 처리하지 않는다. 허용 필드 기반 패킷 외 출력이나 식별정보 canary가 발견되면 최초 전송 전에 차단한다.
- 공개 적격성 검사와 제품 결함의 재현/검수는 다른 단계다. hosted runner를 호출하는 입력도 외부 전송이므로 원본 사건이 아닌 사전 검사된 합성 패킷만 전달한다. 아직 재현되지 않은 합성 fixture를 시험하기 위한 전송은 허용하되 재현·승인 완료로 기록하지 않는다. runner에는 첫 단계부터 원본·운영 secrets가 없어야 하고, 신뢰된 실행 래퍼가 비신뢰 stdout/artifact를 비공개 임시 파일로 받아 검사한 결과만 게시한다. 첫 GitHub 전송 이전의 공개 적격성 검사와 이후 새 출력마다의 게시 전 검사를 혼동하지 않는다.
- migration은 이전 안전 앱/새 앱과 기존/확장 schema 호환표를 갖는다. 과거 열/FK를 제거하지 않는다. 이전 안전 앱은 새 jobs를 처리하지 않고 유지보수 기능이 닫힌 조회 모드로 동작한다. 새 앱이 기존 schema에서 실행되면 maintenance만 미설정/비호환으로 닫는다. 알려진 fail-open 기준 코드는 rollback 대상으로 삼지 않는다.
- DB 복구는 외부 쓰기 중지→복원/권한 확인→GitHub의 이미 발생한 외부 효과와 대조→미확정 작업 보류→worker 재개 순서다. 암호화된 별도 백업과 격리 환경의 복원 시험을 PR-4 완료 조건으로 포함한다. 초기 RPO 24시간, RTO 4시간을 운영 목표로 잡고 실측·사용자 운용 가능 시간에 따라 조정한다. Storage 객체를 쓰면 DB 백업과 별도로 관리한다.

완료 기준: 기존 데이터에서 migration/실패 후 재실행/복원 성공, API/MCP 동일 결과, JWT A/B·공유 actor·anon·직접 DB INSERT·actor 위조의 허용/거부 검사, 트랜잭션 각 단계 실패에서 전부 저장 또는 전부 rollback. PR 성공 후 응답 유실/DB 실패/조회 누락/lease 교체/같은 ID 다른 본문에서 중복 생성 없이 수렴 또는 보류. 원본 사건 canary가 첫 외부 전송 전에 차단됨. GitHub 미설정은 명시적 대기이며 mock URL을 반환하지 않음.

### PR-5 — 자동 패치·독립 AI 검수·재수정 루프

의존: PR-2, PR-3, PR-4. 대상: worker, reviewer adapter, job 상태 전이, PR 생성.

- 사용자 LLM과 무관한 maintenance worker가 작업을 처리한다. 사용자가 검색에 쓰는 LLM은 그대로 선택한다. GCE는 HTTP/MCP와 trusted coordinator의 가벼운 상태 처리만 담당하며 생성된 코드/브라우저/패치 빌드를 실행하지 않는다.
- 1차 실행기는 비밀정보 없는 GitHub-hosted Linux runner로 정한다. 모델 호출 어댑터는 기존 개발 PC의 AGY CLI headless 한 가지로 시작한다. 2026-09-19 `agy --help`에서 print/JSON schema/timeout/sandbox 옵션, `agy models`에서 `gemini-3.1-pro-high` 접근 목록을 확인했다. 이는 실제 생성·검수 성공이나 무료 잔여량의 확인은 아니다. 최초 writer/reviewer는 별도 세션의 해당 모델을 설정하고 실제 호출·권한 제한·quota 처리를 출시 전에 검증한다. 특정 CLI에 종속되지 않는 adapter interface를 유지한다.
- AGY에는 공개 패킷만 제공하고 모델 출력으로 diff/검수 JSON을 받는다. agent의 명령 실행/MCP/게시 도구를 막는 집행 가능한 전용 구성과 격리된 계정/작업공간을 preflight로 확인한다. `--sandbox`나 빈 디렉터리만으로 충분하다고 간주하지 않는다. 차단을 증명하지 못하면 해당 adapter는 `unavailable`이며 기존 사용자 홈에서 생성 코드를 실행하거나 유료 API로 몰래 대체하지 않는다. 모델 호출 프로세스에는 필요한 모델 인증만 두고 DB/GitHub/SSH 자격증명은 전달하지 않는다.
- 작성자 agent는 실제 실패 fixture를 먼저 만들고 현재 버전 실패 → 패치 버전 통과를 기록한다. rules뿐 아니라 `src`/tests의 결함도 수정할 수 있게 하되 작업 범위/시간/파일 제한을 둔다.
- 권한을 세 역할로 고정한다. (1) trusted coordinator: 제한된 DB 기록·상태 전이·Octokit 게시, 생성 코드 실행 금지. (2) writer/reviewer 호출부: 모델 호출만, 운영 DB·merge·deploy 권한 없음. (3) 비신뢰 패치 실행기: 일회성 runner에서 고정된 입력·fixture만 실행, 운영 secrets·호스트 홈·제어 소켓 접근 없음. privileged job은 비신뢰 코드를 checkout/실행하거나 artifact 스크립트를 실행하지 않는다. 단순 임시 폴더나 기존 사용자 계정은 격리로 인정하지 않는다.
- 승인기/coordinator/신뢰된 CI 집계/배포·권한 설정을 수정하는 패치는 일반 자동 수리 allowlist에서 제외해 별도 사람 검토 범위로 보낸다. 법령/실패 문서는 데이터이며 명령·권한으로 해석하지 않는다. GitHub 변경은 서버에서 Octokit으로 수행하고 서버의 shell/git 실행으로 대체하지 않는다.
- reviewer 호출은 coordinator가 고정 설정으로 직접 요청하고 별도 세션에서 수행한다. 작성자가 제출한 review.json/모델명/승인 선언은 승인 증거가 아니다. base/head SHA, diff, correction, 출처/적용일, 신뢰된 runner의 재현 전후·회귀 결과를 전달하고 실제 요청/응답 hash, 작업·attempt ID, 모델/provider/설정, 응답/시각/request ID(제공되는 경우), verdict를 coordinator가 저장한다.
- 재현은 동일한 고정 fixture와 환경/의존성/upstream으로 base와 patch를 실행한 runner 기록이어야 한다. 예상 assertion과 무관한 설치/import/timeout 실패는 해당 결함의 RED로 인정하지 않는다. 작성자는 테스트를 추가할 수 있으나 신뢰된 기준 회귀 테스트 삭제·약화 및 결과 집계 변경은 허용하지 않는다.
- verdict는 Zod enum으로 엄격 검증한다. 빈 응답, `"false"` 문자열, 형식 오류, HTTP 실패, timeout, 키/예산 부재는 승인으로 취급하지 않는다. `approved | changes_requested | needs_evidence | unavailable`를 구분한다.
- 수정 요청은 같은 작업·브랜치에 반영하고 재검증한다. 기본 자동 시도 3회, 작업/일 단위 토큰·시간·비용 상한과 지수 backoff를 둔다. 상한 초과는 보류하며 무한 PR 생성·무한 재시도하지 않는다.
- AI 승인과 재현 결과는 `app/base/head + ruleset + upstream 정확한 버전/설치 무결성 + 의존성 lock + adapter/schema + 검사 정책 + 참조 근거 hash`의 실행 묶음 fingerprint에 묶는다. 한 작업은 고정 upstream으로 시작·완료한다. 새 commit/rebase/참조 근거·계약 변경 때 관련 증거를 무효화하며 무관한 법령 변경까지 전체를 무효화하지 않는다.
- mock reviewer로 수정 요청→재수정 상태기계를 시험한 증거와 실제 별도 모델 호출 성공 증거는 분리한다. 같은 모델의 별도 세션을 오류가 독립적인 두 모델의 합의라고 표현하지 않는다. 이번 계획 Pro 검수도 미래 구현 패치의 승인으로 재사용할 수 없다.

완료 기준: 코드 버그/규칙 버그 각 1건의 고정 fixture RED→패치→GREEN→실제 독립 모델 호출→준비 완료. 수정 요청/재수정 상태기계는 재현 가능한 stub으로 별도 검증하고 실제 모델이 수정 요청한 이력이 있으면 구분해 기록. 위조 승인/다른 SHA 응답/이전 attempt 재사용/테스트 삭제/잘못된 RED/호스트 접근/예산 소진을 거부. 실제 adapter가 미설정이면 이 PR과 최종 출시는 미완료이며 일반 검색은 유지.

### PR-6 — PR 일괄 검수·머지·배포 및 upstream cron

의존: PR-1~5. 대상: GitHub workflows, batch manifest, deploy/updater 설정, 운영 안내.

- 자동 생성 제안은 Draft PR로 관리하고 준비된 것만 검수 묶음에 올린다. 규칙 개별 파일화는 PR-3, 공개 전 검사와 신뢰된 CI 기반은 PR-4/5에서 이미 적용된 상태여야 한다.
- 묶음 화면/문서는 PR별 실패 내용, 수정 범위, 재현 전후, 근거·최신성 상태, AI 검수, CI, 정확한 head SHA를 한 곳에 보여준다. 초기에는 GitHub의 batch PR/체크 보고서를 이용하고 별도 웹 UI는 필수로 만들지 않는다.
- 최종 머지 대상은 구성 PR을 합친 batch PR 하나로 정한다. manifest는 base `B`, batch head `H`, 통합 tree `T`, 구성 PR별 head, 실행 묶음 fingerprint, migration/의존성 식별자와 실제 검사 기록을 고정한다. 합친 상태의 회귀/규칙 충돌/DB 호환을 검사하고 충돌 해결·추가 코드에는 독립 AI 재검수를 한다.
- 사람은 manifest와 H/T를 마지막에 승인한다. GitHub가 만드는 merge commit `M`은 H와 같다고 가정하지 않는다. 1차는 merge-commit 방식만 허용하고 M의 부모가 승인된 B/H인지, tree가 T인지, manifest와 일치하는지 확인한다. head/base/구성 변경 시 재검수하며 검증하지 않은 squash/rebase 머지는 배포되지 않는다. 구성 PR은 따로 머지하지 않고 batch 완료 기록으로 연결한다.
- 배포 산출물도 승인된 tree/manifest와 결합한다. 신뢰된 build 정책으로 생성한 artifact digest를 기록하고 M과 승인된 T의 대응 및 체크의 실제 실행·생산자를 확인한 뒤 해당 artifact만 배포한다. 불일치하면 머지 기록이 있더라도 배포하지 않는다.
- CI는 읽기 권한을 기본으로 하고, PR의 비신뢰 코드를 실행하는 job에 운영 secrets를 넣지 않는다. 생성 agent는 main에 직접 push/merge/deploy하지 않는다. 배포는 사람이 승인한 B/H/T·manifest와 부모·tree 대응이 검증된 실제 merge SHA M에 결합된 artifact만 사용한다. M에 대한 별도 사람 재승인은 요구하지 않는다.
- 배포는 immutable release + health/MCP smoke + 이전 앱/rules/upstream 버전 rollback. SQL은 추가·하위호환 migration을 우선 적용하고 앱 rollback만으로 DB를 되돌렸다고 주장하지 않는다. DB 복구/forward-fix 절차를 별도로 기록한다.
- 기존 updater의 후보 설치→review/smoke, lock/journal/health/rollback/logrotate를 재사용한다. 1차 cron은 자동 감지·후보 설치·검증까지만 수행하고 활성화 후보를 같은 사람 검수 batch manifest에 포함한다. 실제 활성화는 승인된 app/rules/upstream 묶음으로 수행한다. 업스트림 패키지 업데이트를 중단하거나 소스를 포크하는 것이 아니다. 별도 무인 활성화는 호환성 증거·실행 묶음 전환이 확립된 후속 범위다.
- upstream 도구 schema/출력/법령 fixture의 계약 변화는 자동 활성화하지 않고 검토 대상으로 보류한다. cron 실패 시 이전 정상 버전으로 조회 서비스를 유지한다.

완료 기준: 충돌하는 두 PR의 통합 검증 실패 및 정상 두 PR의 단일 사람 검수. 승인 후 head/base 변경, skip/neutral/누락 check, 잘못된 check 생산자, 다른 merge tree, artifact digest 불일치, U1 검수 중 U2 후보 등장 모두 기존 증거의 무단 재사용을 막음. 배포 실패 시 이전 안전 실행 묶음으로 rollback, cron 실패 시 기존 upstream 유지, DB 복원 후 외부 효과 대조. 공개 이력·artifact에 원본 사건 자료/토큰 없음.

## 5. 순서·운영 한도·출시 기준

작업 순서: **PR-0 → 축소 PR-1 → PR-4(접수·권한·복구) → 축소 PR-2(근거) → PR-3(검증) → PR-5(자기수정) → PR-6(일괄 승인·배포)**. v1과 검수 지적의 대응을 유지하려고 PR 번호는 유지했다. HTTPS는 별도 최소 배포 후보로 만들 수 있고, 나머지 PR은 의존성을 표시하여 모아 검수한다. 준비되지 않은 기능은 닫힌 상태여야 한다.

GCE에서 별도 브라우저 크롤러·패치 빌드·LLM 추론을 상주시킨다는 가정은 하지 않는다. 무료 운영 가능 여부와 실제 GCE 여유·Supabase 용량·모델 잔여량은 구현 시작 시 실측한다. 초기 운영값은 아래처럼 설정 파일로 관리하며 계정 전체 제한보다 여유 있게 낮춰야 한다. 비용/서비스 quota 부족은 지연·대기로 처리하고 계정 증설로 제한을 우회하지 않는다.

| 항목 | 1차 기본값/동작 |
|---|---|
| 검색 실행 | REST와 MCP를 합쳐 동시 3개, 요청 timeout 30초, 초과는 429/Retry-After |
| MCP 연결 | 전체 20, actor별 5, 유휴 만료 15분; 실제 장기 연결 시험 후 조정 |
| 개선 처리 | 동시 1, 전체 대기 100건/actor별 20건, 포화 시 접수 429 및 기존 receipt 조회 가능 |
| 입력/출력 | 요청 body 256KiB, 원본 서술 20,000자, 모델 입력 40,000자/출력 32,000자, 원문 1건 1MiB |
| 모델 작업 | 작업 최대 3시도, 모델 호출 하루 20회, 호출 10분/작업 45분 상한; 재시작 후 누적 유지 |
| 요금 | 기존 인증·할당량 범위만 사용, pay-as-you-go 자동 fallback 금지. 금액/토큰 측정 불가 시 0원 또는 사용량 0으로 기록하지 않음 |
| polling | 30초부터 최대 15분 backoff, quota reset/Retry-After 존중, 실패한 작업은 영속 보존 |
| 보관 | 비공개 원본 14일, 근거 본문 캐시 총 100MiB, 로그 20MiB, 재현/검수 메타데이터 180일; 용량 부족 시 원본 신규 저장/개선 접수 제한 |
| 복구 | 일일 암호화 DB 백업, RPO 24시간·RTO 4시간 목표, 격리 복원 성공 필요 |

이 숫자는 운영 보장이나 법정 보존기간이 아니라 초기 상한이다. 관련 서비스/계정의 실제 제한이 더 낮으면 그 한도를 적용한다. DB·worker·모델이 대기 상태여도 조회 서비스를 가능한 범위에서 유지하되, 최신 근거 확인까지 실패했다면 해당 결과는 미검수로 표시한다.

출시 검수의 핵심은 다음 네 가지다.

1. 새 컴퓨터에서 MCP 연결·검색이 되고 HTTPS로만 통신한다.
2. 안 했거나 못한 검사를 통과로 표시하지 않으며 법령 시점과 출처를 확인할 수 있다.
3. 실패 1건이 기록·재현·코드/규칙 수정·독립 검수·재수정을 거쳐 하나의 검수 가능한 PR이 된다.
4. 여러 PR과 upstream 후보를 모아 사람 한 번의 최종 검수 후 승인된 내용과 대응하는 정확한 실행 묶음만 배포하고 복구할 수 있다.

1차에서 미루는 것은 광범위 클라이언트 자동 설치, 직접 OAuth, 범용 규칙 언어, 전 기관 지식 그래프, 다중 모델 합의/다중 worker, 별도 관리 UI, upstream 무인 활성화다. 실제 코드 버그와 규칙 버그의 자기수정 루프는 1차 출시 필수이며 영구히 다음 단계로 넘기지 않는다.

## 6. 독립 검수에 요청하는 판단

이 계획이 목표를 달성하는지, 불필요한 확장인지, 수정 순서/마이그레이션/실패 복구/무료 자원 제약에서 빠진 조건이 있는지 검토한다. 특히 공유 API key actor와 RLS, 공개 PR의 사건 정보 유출 방지, 선택형 초안 검증의 한계, 법률 근거의 불확실성, 외부 AI 검수 실패 시 상태, SHA에 묶인 사람의 일괄 승인, upstream 자동 업데이트와 검증 무효화를 비판적으로 검수한다.

실제 코드 수정 완료나 법률 내용의 적법성 승인을 요청하는 것이 아니다. 제공된 사실/코드의 확인 범위를 넘어서 테스트·서버 확인을 수행했다고 주장하지 않아야 한다.
