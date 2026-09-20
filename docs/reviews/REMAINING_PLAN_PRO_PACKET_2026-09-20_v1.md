# Remaining implementation plan — independent Pro review

Packet v1. Created 2026-09-20T03:29:57.682Z. Repository HEAD before this plan: 449f7f01fe7f2999e2ad4a41dfcb9096fe0730fb.

Scope: review the remaining plan, dependencies, acceptance criteria and safe deployment ordering. This is not a request for code re-review, legal advice, production GO or permission to merge. The actual last Pro response was reread from the existing conversation. No implementation/deployment/migration is performed in this plan-only turn.

Observed runtime diff from reviewed code e7ce0b2214c94dae1f3f2e96281b045635ddb4c5: empty across runtime/scripts/tests/rules/deploy/dependency/SQL/config paths. Prior tests are attributed to their actual executor, not rerun for docs.

Only the allowlisted public plan, validation manifest and prior Pro review record are included. No .env, account secrets or private case documents are attached.

## Included file hashes

- docs/REMAINING_PLAN_2026-09-20.md: b22b6ed9ab4d07b54e8b82c9fd6181be8d900904571ea18173b3f5982aa88c58

- docs/reviews/DEPLOYMENT_VALIDATION_2026-09-20.json: 4d1d9ae09f0c3a84eca6f523e76aba166d790387437aaa2b14463076e54caaba

- docs/reviews/DEPLOYMENT_PRO_REVIEW_2026-09-19.md: 204ade7dd0d0c77e0cd6c5761939e19db7f70b50a0183eac921f6c412ed741f1


## FILE docs/REMAINING_PLAN_2026-09-20.md

# Legal Harness 남은 구현·운영 전환 계획

상태: v1, 별도 ChatGPT 6 Pro 계획 재검수 제출용. 이 문서는 실행 승인이나 배포 완료 선언이 아니다. 사용자의 마지막 일괄 검수·머지 방식을 유지한다.

## 1. 받은 검수 응답과 이번 계획의 기준

2026-09-20에 [Pro 검수 대화](https://chatgpt.com/c/6aae9b76-b7d8-83e8-b743-71f206c6b9dd)의 마지막 응답을 다시 확인했다. 판정은 **조회 전용 제한 후보 CODE PASS / 실제 운영 배포 HOLD**다. R1~R5, A/B, A-1 수정은 검수되었으며 새로운 반례나 코드 변경 없이 같은 결함을 다시 미해결로 올리지 않는다.

- 검수한 실행 코드: `e7ce0b2214c94dae1f3f2e96281b045635ddb4c5`.
- 계획 착수 HEAD: `449f7f01fe7f2999e2ad4a41dfcb9096fe0730fb`. 위 코드 이후 변경은 검수 문서 4개뿐이다.
- [Draft PR #3](https://github.com/hyunae52/legal_harness/pull/3): open, draft, 미머지. 기존 PR #1/#2를 따로 머지하지 않는다.
- 구현자 실행: Windows / Node 24.13.1에서 `npm run review` 68/68, `npm run review:package` 6/6. skip 없음. [증거 manifest](reviews/DEPLOYMENT_VALIDATION_2026-09-20.json).
- 마지막 시험 tarball SHA-256: `08fe3e6d24a22d1d68e4db278b29d43d96f627339999a897423114b0a2cf7f61`. 이 파일은 Windows에서 만든 검증 artifact이며 이후 Linux 배포 artifact가 자동으로 같은 파일이라고 가정하지 않는다.
- Pro는 최종 경합을 합성 SDK로 직접 비교했다. Pro가 68개 전체 시험·실제 stdio 통합·최종 tarball 검증을 재실행했다는 뜻은 아니다.
- 10초 upstream 기동 실패 1회는 원인 미확정이다. 동일 코드의 단독·전체 재실행 통과로 운영 안정성을 확정하지 않는다.
- 2026-09-20 03:24 UTC의 자격증명 없는 읽기: `https://law.taxlab.kr/health`는 `ENOTFOUND`, 기존 공개 HTTP 3000 health는 200 / `mcp_release:null`. Cloudflare 설정의 원인은 아직 추정하지 않는다.
- 운영 배포, DB migration, cron 등록, 실제 자동 수정 worker 활성화는 하지 않았다. CI 파일은 권한 부족으로 예제에만 있으며 Linux CI 실행 증거가 없다.

이 계획이 이전 [구현 계획](IMPLEMENTATION_PLAN_2026-09-19.md)의 남은 작업 순서를 대체한다. 이전 문서의 초기 실패 개수·미수정 설명은 과거 관찰이며 현재 상태로 재사용하지 않는다.

## 2. 출시 범위와 현재 구현의 경계

사용자가 원하는 완성형은 **임의의 MCP 지원 LLM → 공식 법령 조회·시점 확인 → 실패 재현 → AI 수정 → 별도 AI 검수·재수정 → PR 취합 → 마지막 사람 검수**다. 세법·노동법·4대보험을 대상으로 하며 일반 조회에 서버 LLM 키를 요구하지 않는다. `korean-law-mcp`는 공식 npm 패키지의 별도 stdio 프로세스로 유지한다.

| 영역 | 현재 근거 | 남은 일 / 완료로 표시하지 않을 것 |
|---|---|---|
| 인증·bridge·요청 수명 | 코드 검수 및 로컬 통합 시험 통과 | 실제 HTTPS, Linux, 사용자 클라이언트, 운영 복구 |
| 자료 확인 | 새 upstream 프로세스로 법령/연혁 조회, KST 날짜 비교, 부분 성공 보존, 제한된 메모리 캐시 | 영속 근거 묶음, 무효화, 부칙·예규 후속 해석 확인 |
| 초안 검사 | 엄격 schema, 해시, 누락 사실·산식·검사 범위 표시 | 법적 결론의 자동 확정이나 임의 초안의 의미 검토를 완료한 것은 아님 |
| Supabase | 추가 DDL와 PGlite 권한/원자 접수 시험 | 운영 schema 대조·migration·실제 RLS·복원 시험 |
| 실패 접수 | 허용된 합성 재현 ID만 접수, actor/idempotency/RPC | 일반 사건 문서 수집 기능 아님. worker 실행과도 별개 |
| 자기수정 | coordinator/검수/runner/GitHub 포트 계약·단위시험 | 실제 격리 실행기·모델·대기열 연결 및 end-to-end 실행 |
| release·cron | 증거 읽기 검증기, 후보 준비/명시적 전환 도구 | 신뢰된 build·배포기·일괄 승인과 연결된 활성화 |

**출시 A**는 공개 HTTP를 해결하는 조회 전용 중간 배포다. 접수·worker·자동 활성화를 닫으며 DB migration을 선행조건으로 묶지 않는다. **출시 B**는 원래 목표인 자기수정까지 포함한 첫 완성형이다. A 완료를 전체 프로젝트 완료라고 보고하지 않으며 B의 아래 합격 기준을 유지한다. Streamable HTTP/OAuth·모든 클라이언트 자동 설치·전 기관 상시 수집·다중 모델 합의는 이번 완료 조건에 추가하지 않는다.

## 3. 공통 실행 원칙과 증거

- 작업 묶음마다 base/head/tree, 실행 코드·규칙·lock·upstream·정책 버전, artifact digest, 시험 환경/명령/결과/실패 이력을 기록한다. 증거 없는 항목은 `pending`/`unavailable`이다.
- 로컬 문서만 바꿀 때 기존 68개를 반복 실행하지 않는다. 실행 파일 변경 시 관련 회귀 및 최종 전체 gate, 의존성/설치 변경 시 package gate, 운영환경 변경 시 Linux/운영 시험을 수행한다.
- 신뢰된 검증기·workflow·기존 회귀시험·배포 스크립트·권한 정책은 자동 패치 범위에서 제외한다. 필수 job/step은 실제 실행된 `success`여야 하며 skip/neutral/cancelled/누락/다른 head는 실패다.
- 실제 사건 파일·원본 실패 문구·비밀값을 외부 AI, runner, Git commit, PR, artifact에 보내지 않는다. 먼저 제한된 구조화 정보와 합성 fixture로 재현하고, 새 출력도 공개 적격성을 검사한다. 마스킹 정규식만으로 완전한 익명화가 됐다고 보지 않는다.
- 리소스·권한이 없으면 해당 단계만 보류하고 독립적인 준비는 진행한다. 유료 API나 새 서버를 자동 구매하지 않고 credential 권한을 몰래 늘리지 않는다.

## 4. 출시 A — Linux 증거와 HTTPS 전환

### A0. 대상·접근·자원 확인 (읽기 우선)

1. GCE 프로젝트/zone/instance/현재 IP/host fingerprint를 대조한다. 오래된 `gce` SSH 별칭을 그대로 사용하지 않는다. 현재 앱·Node·PM2/systemd·cloudflared·cron·listen 포트·방화벽·메모리·디스크와 복구용 SSH 경로를 기록한다.
2. Cloudflare에서 실제 tunnel connector 상태, DNS proxy, origin 경로, 인증서 상태를 확인한다. DNS 실패 원인은 확인 전 단정하지 않는다.
3. Supabase 기존 schema/migration 이력은 읽기 확인만 한다. A에서는 server-only DB 쓰기 credential을 주입하지 않아 `/health`의 maintenance가 `unavailable`이고 접수도 명시적으로 거부되는지 확인한다.
4. GitHub Actions 접근을 확인한다. 현재 push credential에는 workflow 권한이 없다. 이미 권한이 있는 저장소 소유자의 경로로 같은 PR 브랜치에 검수한 workflow를 등록할 수 있어야 A1을 진행한다. default branch 선행 머지나 권한 우회로 해결하지 않는다. 불가능하면 CI를 실행했다고 표시하지 않고 HOLD한다.
5. GCE·Supabase·Actions·모델의 실제 계정 잔여 한도를 기록한다. 무료 사용 가능 여부를 상품 이름만으로 보증하지 않는다. GCE에는 조회 서비스와 작은 coordinator만 상주시키며 비신뢰 패치 시험은 두지 않는다.

산출물: 비밀값 없는 대상 inventory, 접근 가능/불가 목록, 실제 한도·자원 기록, 검수 가능한 배포/복구 명령안. 합격: 대상 식별과 복구 접근이 확인되고 자원 예산을 넘지 않는 시험 환경을 준비할 수 있음.

### A1. Linux CI·기동·설치·자원 시험

1. `deploy/review.workflow.yml.example`를 기반으로 Ubuntu 24.04 / Node 22의 정확한 patch 버전·runner image 정보를 기록하고 clean `npm ci` → `npm run review` → `npm run review:package`를 실행한다. Windows 증거와 Linux 증거는 별도로 보존한다. workflow와 검증기는 사람이 검수한 고정 revision을 사용한다.
2. secret 없는 ephemeral runner에서 검수한 head를 시험한다. 운영 DB/GitHub 쓰기/SSH/model credential을 넣지 않는다. action revision, producer, event, commit, 필수 step 결과를 provider API로 확인한다. workflow가 등록됐다는 것만으로 CI 통과로 세지 않는다.
3. 대상 VM과 같은 Node/OS 및 자원 제한에서 공식 upstream의 cold-start 20회와 따뜻한 연결 호출을 시험한다. 각 시작은 기존 10초 제한 내 성공해야 한다. timeout·cleanup 지연·이벤트 루프 지연·CPU/RSS/자식 수를 기록하고 한 번이라도 실패하면 원인 확인 후 관련 수정/시험을 한다. 통과할 때까지 재실행한 마지막 결과만 제출하거나 제한을 임의로 늘리지 않는다.
4. 15분의 제한된 자원 시험: 합성 지연 upstream으로 3개 동시 작업, 초과 요청 429, timeout/연결 종료/재접속/종료 후 자식 정리를 검증한다. 실 법제처 조회는 실제 승인 quota 내 최대 20회로 제한한다. OOM/비정상 재시작/종료 후 고아 자식 0, 작업 종료 후 점유 슬롯 0, process group 합계 최대 RSS가 VM RAM의 70% 이내여야 한다. 부족하면 부하·worker 공존 계획을 줄여 다시 설계하고 자동 증설하지 않는다.
5. 검수 artifact를 별도 디렉터리에 설치하고 앱 루트에서 lock 기반 `npm ci` 후 실제 의존성 버전을 대조한다. 깨끗한 Linux bridge와 Windows bridge에서 `doctor`, 도구 목록, 인증된 합성 호출을 확인한다. 서로 다른 실제 MCP 클라이언트 두 개의 표준 stdio 조회도 확인하고 지원표에는 시험한 조합만 적는다.
6. upstream 목록/기동이 정상인데 자료 조회가 실패하면 출처 장애로 따로 기록한다. `available`/`retrieval_only`/`unverified` 상태가 유지되는지 검사한다. 외부 자료 장애를 내부 테스트 통과나 법적 유효성 확인으로 바꾸지 않는다.

산출물: Linux CI run/step 증거, 20회 시작 기록, 자원·종료 시험, 설치·클라이언트 지원표, 후보 artifact manifest. 합격: 필수 검사 전부 실제 성공, 기동 원인 미확정 사항 해소, 위 상한 충족. 실패면 A2 준비는 계속하되 배포 후보는 HOLD.

### A2. 전환·복구를 먼저 준비하고 사람에게 한 묶음으로 제출

1. 후보를 별도 release 디렉터리/loopback 포트에 준비한다. secrets는 artifact 밖에 두며 app/rules/lock/upstream/config schema를 고정한다. 공개 route나 현재 프로세스를 아직 전환하지 않는다.
2. 격리된 route 또는 loopback/SSH 경로에서 앱 기동, header 인증, REST/SSE/messages, 정상 법령 조회, 연결 종료를 시험한다. cloudflared/DNS/방화벽 변경 명령과 적용 전후 기대 상태를 확정한다. 최종 공개 도메인의 성공은 실제 전환 후에만 관찰할 수 있으므로 사전 증거와 구분한다.
3. 무인 업데이트·옛 `/api/evolve`·`propose_tax_rule`을 비활성 상태로 유지한다. 신규 credential 누락/잘못된 key/query 인증/다른 actor 세션/허용되지 않은 Origin이 거부되는지 시험한다. 인증값은 URL·출력·녹화에 넣지 않는다.
4. 안전한 rollback 최저 조건은 HTTPS+loopback+header 인증+옛 자동 PR 경로 폐쇄다. 현재 운영 중인 구형 HTTP 앱을 복구 대상으로 쓰지 않는다. 기존 안전 release가 없다면 최초 전환의 실패 복구는 **검증한 HTTPS maintenance 503 상태**로 한다. 이 상태와 전환·복구를 사전에 시험하고 첫 배포의 무중단 복구를 보장한다고 쓰지 않는다. 첫 정상 A release를 확보한 뒤 다음 배포부터 그 artifact로 되돌린다.
5. 신뢰된 build가 검수 tree에서 artifact를 만들고 해시·실제 설치 의존성을 기록한다. 코드 리뷰 대상과 배포 artifact 연결, 이전 안전 artifact 또는 maintenance 절차, 변경 명령, 성공/중단 기준을 PR에 넣는다. 미완료 자기수정 기능은 활성화 항목에 포함하지 않는다.
6. 사람은 **현재 B/H/T, manifest, 배포·복구 절차와 전환 후 자동 판정 조건을 한 번 최종 검수**한다. 이때 준비 작업을 마친 reviewable 결과를 제시한다. 계획 검수 응답만으로 이 승인을 대신하지 않는다. head/base/tree 또는 승인 대상 설정·artifact가 바뀌면 기존 승인을 재사용하지 않는다.

### A3. 승인 후 실행할 운영 전환 및 판정

1. 검증기에서 승인 B/H/T와 실제 merge M의 부모/내용 tree를 대조한다. M SHA가 H와 같을 것을 요구하지 않는다. 필수 CI·review 증거·artifact digest를 확인한 신뢰된 배포기가 정확한 artifact를 사용한다. 사람이 이미 승인한 동일 묶음에 M만 새로 생겼다는 이유로 별도 재승인을 요구하지 않는다.
2. loopback 후보 정상 상태 → Linux cloudflared route 전환/DNS 정상화 → 외부 HTTPS header 인증 실제 조회 → 같은 배포 창에서 외부 TCP 3000 ingress 폐쇄 및 구형 listener 종료 → 독립 외부 네트워크 확인 순서로 수행한다. SSH 복구 경로는 유지한다. 구형 클라이언트 전환을 무기한 기다리지 않는다.
3. 전환 시작 후 15분 안에 최종 HTTPS 정상/인증 거절 시험 및 public IPv4·사용 중인 IPv6의 3000 차단을 확인한다. 자동 합격은 `/health`의 검수 버전·fingerprint 일치, 인증된 실제 MCP 호출, 음성 인증·session 시험, 외부 HTTP 차단, 서비스 재시작 후 동일 동작을 모두 요구한다. 단순 health 200은 충분하지 않다.
4. 실패하거나 관찰 불능이면 GO를 내지 않는다. 공개 3000을 닫고 이전 안전 HTTPS release 또는 사전 검증 maintenance 상태로 복구한다. DNS/터널 설정은 안전 경계가 유지되는 확인된 상태로만 되돌리며 공개 HTTP를 재개방하지 않는다. 복구 실패/상태 불명은 자동 재시도·재전환을 중단하고 명확히 알린다.

사전 상태는 `READY_FOR_HUMAN`, 전환 중은 `VERIFYING`, 실제 후속 검증 성공 후에만 `A_LIVE_VERIFIED`다. 최종 도메인 성공을 승인 전 반드시 실행해야 하는 순환 조건으로 만들지 않는다. A 완료 보고에는 DB/worker 미활성 및 B 미완료를 함께 적는다.

## 5. 출시 B — 사용자가 원한 자기수정 기능 완성

다음 작업은 A 준비와 독립적으로 구현할 수 있다. 실제 운영 활성화는 각 단계 증거와 최종 B batch 승인을 요구한다.

### B1. Supabase 접수·근거 저장 기반

- 기존 `profiles`/`evolution_logs`/migration 이력과 추가 DDL를 대조한다. 기존 데이터·auth UUID는 유지하고 expand-only migration을 준비한다. Supabase의 `auth.users`를 별도 사용자 테이블로 재생성하지 않는다.
- 격리된 PostgreSQL/Supabase 시험에서 실제 anon/authenticated/server-only 역할, API actor/JWT 소유권, 과거 직접 INSERT 폐쇄, RPC 원자성, idempotency payload 충돌, queue 한도, fenced lease·오래된 worker 거절을 검증한다. PGlite 통과를 실제 Supabase 증거로 대체하지 않는다.
- 백업을 암호화하고 격리 복원 후 행 수/참조·권한·schema 호환을 검증한다. 목표 RPO 24시간/RTO 4시간은 실제 복구 시험으로 확인하며 달성 전 보장이라고 쓰지 않는다. GitHub 외부 효과는 DB 복원만으로 취소되지 않으므로 intake/worker/publisher를 중지하고 intent·branch·PR을 대조한 뒤 재개한다.
- 근거 저장에는 원 출처 문서 식별자/버전/hash/조회시각/공포·시행일, 사건 역할별 날짜, 접근·버전 선택·적용/부칙·후속 해석 확인 상태를 따로 둔다. 사용자별 초안·facts·receipt는 비공개 소유권 경계에 두고 public 실패 접수에 원문을 추가하지 않는다.
- 운영 migration은 B 최종 승인 창의 순서에 넣고 호환성 확인 전 접수를 열지 않는다. 설정 누락/DB 오류는 명시적으로 거부하고 정상 접수로 위장하지 않는다. 운영 성공 전 A는 계속 조회 전용으로 동작한다.

합격: 실제 권한·원자성·복원 시험, 이전 안전 조회 앱과 새 schema의 호환, 소유권 누출 0, 중복 외부 실행 없는 복구 시나리오. 산출물: additive migration·전후 검증·복원 기록·서버 설정 목록(값 제외).

### B2. 근거 갱신·검수 영속성 및 FC-01~10

- B1 저장소 위에서 source/evidence/validation receipt를 구현한다. 관련 원문·법령/해석 버전·규칙·사건 facts·초안이 달라지면 검수 유효성을 해제하고 재검증한다. 중요한 근거는 최종 검수 전 원 출처를 재확인한다. npm 업데이트 cron과 자료 확인 주기는 별개다.
- 메모리 캐시의 현재 상한은 20개×200KB, TTL 24시간이다. 이것을 새로운 영속 저장소 보존 정책으로 그대로 복사하지 않는다. 영속 자료는 원문 접근 약관·계정 용량을 확인하고 크기/기간/삭제 정책을 migration 전에 명시한다. 접근 실패 시 마지막 자료와 경과 시간을 제공하면서 최신 확인 완료라고 하지 않는다.
- 1차 범위는 요청·규칙에 실제 필요한 법령/시행령/시행규칙/부칙 및 관련 예규다. 현행·미래 시행·과거 사건·부칙 미확인·예규 상충·후속 폐기 확인 불능·출처 장애의 fixture를 구분한다. 예규의 폐기/대체를 확인할 수 없으면 상태를 유지하며 억지로 결론내리지 않는다.
- 세법·근로기준법과 4대보험 법령의 조회 경로를 공식 upstream으로 시험하고 기관별 부족분만 adapter로 보완한다. 유료 scraping API는 기본 의존성으로 만들지 않는다.
- FC-01~10에서 누락 사실·부정문·인용·표현 변형·산식·관련 근거를 검사한다. FC-08~10의 disputed 안분식을 정답으로 승격하지 않는다. 소유자별 지분/원가/실제 부담/정산·시가/관리처분 전후는 분리하며 근거 부족은 `needs_info` 또는 `unverified`다.
- 구조화 산식과 본문 주장 일치를 구분하고 실행하지 않은 의미 검사는 `unverified`다. exact draft/facts/evidence hash와 정책·실행 fingerprint가 맞는 서버 receipt만 사용한다. 필수 검사 미실행/skip은 완료나 scoped pass가 될 수 없다.

합격: 위 출처/시점 fixture와 버전 변경 무효화, 소유권·캐시 경계, 모든 진입점 공통 결과. 조회 성공을 법적 확정으로 바꾸지 않음. 산출물: evidence 저장소/adapter·검수 receipt·실증된 지원표.

### B3. 실제 모델·runner·worker 연결

- GCE의 신뢰된 coordinator는 큐·예산·outbox만 관리한다. 코드 작성·별도 검수 모델은 각기 새 세션으로 실제 호출하고 동일 제공자를 쓰면 독립된 모델 합의로 표현하지 않는다. 현재 AGY의 실제 headless 옵션/선택 모델/접근 quota와 비용을 preflight로 확인한다. 사용 가능한 모델이 없으면 `unavailable`, quota 소진은 `waiting_quota`이며 유료 fallback이나 가짜 승인은 없다.
- 모델 환경에는 모델 인증만 넣고 DB/GitHub 쓰기/운영 SSH credential을 넣지 않는다. repo/명령/파일 실행 도구 차단을 실제로 집행할 수 있는 격리 adapter를 먼저 시험한다. 단순 프롬프트 금지가 아니라 canary 명령/도구 시도가 실행되지 않는 증거가 필요하다. AGY에서 이 경계가 성립하지 않으면 adapter 미준비로 두고 지원되는 격리 호출 경로를 별도로 검수한다.
- 수정 코드는 disposable hosted Linux runner에서만 실행한다. 운영 credential·host socket·지속 캐시·쓰기 token·self-hosted GCE 실행을 금지한다. 제어 workflow/검증기와 숨겨진 신뢰 fixture는 패치가 수정할 수 없고, 결과의 producer/event/base/head/fixture digest/종료 사유를 coordinator가 provider에서 대조한다. untrusted 출력의 `approved`나 자체 작성 test report를 신뢰하지 않는다.
- 합성 public packet을 최초 외부 전송 전에 검사한다. base와 patch에 동일한 신뢰 fixture를 실행하여 **해당 원인의 RED → GREEN**을 확인한다. base의 설치 오류/timeout은 재현 성공이 아니다. 새 시험은 별도로 검수하고 기존 시험 삭제·약화로 통과할 수 없다.
- 실제 별도 AI에는 diff, 근거, correction, 재현·gate 결과와 정확한 hashes를 보낸다. `approve/revise/reject/unavailable` strict 결과·producer·요청 ID·세션을 기록한다. 빈 출력/형식 불량/불일치/기한 만료는 승인되지 않는다. 수정하면 이전 verdict는 무효이며 동일 절차를 다시 통과한다.
- worker concurrency 1, job lease 45분 및 fencing, 최대 패치 시도 3회, 모델 1회 최대 10분, 하루 모델 호출 최대 20회와 실제 계정 quota 중 더 작은 한도를 적용한다. 허용된 시간·토큰·반복 예산은 DB에서 원자 예약/누적한다. 재시작·lease 회수·동일 semantic fingerprint로 예산이 초기화되지 않아야 한다. 장기 호출은 lease heartbeat 및 취소·오래된 결과 차단을 시험한다.
- outbox의 operation intent/고정 branch/exact commit을 먼저 기록하고 GitHub의 실제 branch/PR을 대조한다. 외부 쓰기 성공 여부가 불명확하면 재전송하지 않고 보류·대조한다. DB rollback으로 이미 생성한 PR을 없었던 것으로 보지 않는다.

합격: fake port가 아닌 실제 경로로 **코드 결함 1건 + 규칙 결함 1건**을 합성 입력→base 재현→패치→독립 AI 검수→실제 CI→draft PR까지 완료한다. 또한 형식 불량/모델 quota/runner 실패/lease 중복/DB 복원/PR 작성 응답 유실 시 거짓 승인·중복 게시 0을 확인한다. 모든 commit·path·로그·PR metadata·artifact·모델 입출력의 synthetic private canary 반출을 시험한다. canary 통과를 모든 개인정보 자동 익명화의 증명으로 쓰지 않는다.

### B4. 일괄 승인·배포기·upstream cron 결합

- batch는 승인 대상 B(base)/H(head)/T(tree)와 app/rules/lock/upstream/policy/evidence fingerprint를 고정한다. 사람은 정확한 묶음을 한 번 검수한다. 구성 PR 개별 통과만으로 통합 묶음의 승인·시험을 대신하지 않는다.
- 실제 merge M의 부모 및 tree 대응, 신뢰된 CI 생산자/event/필수 step 성공, artifact digest를 배포기에 연결한다. 현재 `release:verify`는 읽기 검증기일 뿐이므로 privileged builder/deployer를 별도 구현·검수한다. build가 미검수 tree에서 코드를 실행하거나 untrusted artifact를 받아 production credential과 결합하지 않게 한다.
- 사전 검수 artifact와 merge tree가 동일함을 확인해 동일 artifact를 사용한다. 다시 build하는 방식이라면 새 artifact를 동일 정책으로 검증하고 승인된 manifest가 허용하는 재현성 계약을 만족해야 한다. 단순히 버전 문자열이 같다는 이유로 대체하지 않는다.
- upstream cron은 lock과 전체 설치 의존성 fingerprint가 있는 **업데이트 후보만** 만든다. 작업 중 U1은 고정하고 새 U2를 자동 주입하지 않는다. U2 후보는 회귀/근거 영향 검토를 거쳐 다음 human batch에 넣는다. 승인·관계가 달라진 이전 검수는 재사용하지 않는다.
- 실제 cron 등록·journal·디스크 상한·중복 실행 방지·후보 정리·활성화·실패 복구를 시험한다. 활성화 성공 후 health fingerprint를 확인하고 실패 복구의 실패도 HOLD로 남긴다. npm 소스 복사나 무검수 `latest` 실행은 하지 않는다.
- B 운영 순서는 외부 쓰기 정지·백업 → additive migration/권한 확인 → 검수 artifact → intake → worker/publisher의 제한적 활성화 → 실제 상태·롤백 확인이다. 실패 시 worker/publisher/intake를 닫고 호환되는 A 안전 조회 release로 돌아간다. SQL rollback과 앱 rollback은 구분한다.

합격: B1~B3 실제 증거, batch 승인 변경 거부, 실제 artifact 전환/안전 복구, cron 후보 U2와 진행 중 U1 격리. 이후 사람의 B 최종 검수까지 통과한 정확한 묶음만 운영 활성화한다.

## 6. 실행 순서·검수 요청·완료 조건

| 우선순위 | 준비/구현 순서 | 선행조건 | 검수 산출물 |
|---|---|---|---|
| 1 | A0 → A1·A2 준비 | 접근 가능한 정확한 대상 | Linux/자원/기동/설치 증거, 전환·복구 명령, artifact |
| 2 | A 최종 human batch → A3 | A1/A2 합격 및 고정 manifest | 실제 HTTPS·외부 3000 차단·복구 판정 |
| 3 | B1 → B2, B3 격리 adapter/runner 준비 | DB 격리 시험 가능, 합성 공개 packet | DDL/복원, 근거/규칙/receipt, 실제 실행 경계 |
| 4 | B3 통합 → B4 구현·격리 시연 | B1/B2 계약·실제 AI/runner | 코드·규칙 각 1건 live loop, 일괄 승인·cron·복구 |
| 5 | B 최종 human batch → 운영 활성화 | 전체 실제 증거·한도·호환성 | 사용자의 전체 목표 완료 보고 |

작업자 Codex는 구현·증거 수집을 진행하고 별도 Pro는 정확한 변경 범위를 검수한다. 현재 Pro 요청은 **이 남은 계획의 순서·누락·합격 기준 검수**이며 배포 승인 요청이 아니다. 실제 배포·머지는 이 문서 작업에서 실행하지 않는다.

지금 확정된 외부 제약은 workflow를 쓸 수 있는 권한 경로 미확보다. GCE/Cloudflare 접속·실제 무료 한도·AGY 격리·Supabase 복원 가능 여부는 A0/B 단계에서 확인할 항목이다. 아직 확인하지 않은 것을 모두 사용자에게 준비물로 떠넘기지 않는다. 기존 자원으로 가능한 준비를 끝내고 권한 조치가 꼭 필요한 경우에만 대상·변경·이유를 구체화한다.

전체 완료 조건: 두 실제 MCP 클라이언트에서 HTTPS 조회, 근거 최신성/사건 시점 불확실성 표시, 안전한 실패 접수와 실제 자기수정 두 사례, 별도 AI 판정, 마지막 사람 일괄 승인, 승인 artifact의 운영 활성화·복구 및 검수된 upstream 후보 갱신. 어느 하나가 mock/문서뿐이면 그 범위는 미완료로 남긴다.



## FILE docs/reviews/DEPLOYMENT_VALIDATION_2026-09-20.json

{
  "code_commit": "e7ce0b2214c94dae1f3f2e96281b045635ddb4c5",
  "environment": {
    "platform": "win32",
    "node": "v24.13.1"
  },
  "review": {
    "command": "npm run review",
    "pass": 68,
    "fail": 0,
    "skipped": 0,
    "cancelled": 0,
    "todo": 0,
    "duration_ms": 32242.7682,
    "executed_by": "implementing_agent",
    "linux_ci_executed": false,
    "earlier_transient_failure": "An unchanged upstream startup test hit its 10s timeout; isolated and full reruns passed without modifying code or limits."
  },
  "package": {
    "status": "pass",
    "artifact": "k-tax-agent-backend-2.2.0.tgz",
    "sha256": "08fe3e6d24a22d1d68e4db278b29d43d96f627339999a897423114b0a2cf7f61",
    "files": 30,
    "checks": [
      "clean_install",
      "stdio_sse_authenticated_call",
      "doctor",
      "packaged_rules",
      "published_lock",
      "installed_dependency_versions"
    ],
    "versions": {
      "@modelcontextprotocol/sdk": "1.30.0",
      "@octokit/rest": "21.1.1",
      "@supabase/supabase-js": "2.116.0",
      "dotenv": "16.6.1",
      "express": "4.22.2",
      "js-yaml": "5.4.2",
      "korean-law-mcp": "4.13.0",
      "zod": "3.25.76"
    },
    "fixture_only": true
  },
  "pro_input": {
    "path": "docs/reviews/DEPLOYMENT_PRO_PACKET_2026-09-20_v4.md",
    "sha256": "cbc95e0561fc90684321bb1a95f2a8cac77e5b69d10d93e3dad98798d5a2e94d"
  },
  "production": {
    "merged": false,
    "deployed": false,
    "database_migration_applied": false,
    "approval": "hold"
  },
  "independent_review": {
    "model_ui_label": "6 Pro",
    "conversation_url": "https://chatgpt.com/c/6aae9b76-b7d8-83e8-b743-71f206c6b9dd",
    "round": 4,
    "processing_duration": "3m 50s",
    "code_verdict": "CODE PASS",
    "scope": "retrieval-only limited candidate; final A-1 delta; earlier findings resolved in preceding rounds",
    "production_verdict": "HOLD",
    "reviewer_executed": [
      "packet_and_3_source_hashes",
      "v3_v4_runtime_diff",
      "synthetic_sdk_race_before_and_after",
      "prior_A_synthetic_scenario"
    ],
    "reviewer_did_not_execute": [
      "full_npm_suite",
      "actual_sdk_stdio_integration",
      "final_package_tgz_verification"
    ]
  }
}



## FILE docs/reviews/DEPLOYMENT_PRO_REVIEW_2026-09-19.md

# 독립 Pro 코드·배포 검수

**최종: 조회 전용 제한 후보 CODE PASS / 실제 운영 배포 HOLD.** 4차 Pro 검수에서 A-1 해소 및 해당 수정 범위의 잔여 P1/P2 없음으로 판정했다. 전체 자동 자기수정 서비스의 production 완료나 merge·배포 실행 승인이 아니다. 최종 실행 코드 기준은 `e7ce0b2214c94dae1f3f2e96281b045635ddb4c5`이며 이후 변경은 검수 문서뿐이다.

- 요청: 수정 후 별도 Pro 모델의 배포 검수.
- 실행: ChatGPT 새 대화의 모델 선택기 **6 Pro**를 확인하고 코드 스냅샷 첨부.
- 대화: https://chatgpt.com/c/6aae9b76-b7d8-83e8-b743-71f206c6b9dd
- 1차 입력 commit: `7309a3776787bd26e58d5137b9122a9904224cab` (로컬 `review/pro-input-20260919` 태그 보존).
- 입력: [53개 파일의 코드·시험·계획 패킷](DEPLOYMENT_PRO_PACKET_2026-09-19_v1.md), SHA-256 `d04450c0c486944b0ab373c4e9b33733bf8af8b1d408416fc0471203f13c7d4d`.
- `.env`의 credential 값과 일치하는 내용이 패킷에 없음을 검사했다. 원본 개인 사건 자료를 포함하지 않았다.
- PR: https://github.com/hyunae52/legal_harness/pull/3 (Draft).

## 1차 판정

17분 32초 처리 후 **전체 production NO-GO / 제한 배포 후보 CODE REVISE·배포 HOLD**. 신규 P1은 확정하지 않았고 실제 연결된 경로에서 P2 다섯 건을 확인했다.

Pro는 첨부 53개 파일의 hash 일치를 확인했다. npm registry DNS 오류 때문에 전체 npm 시험을 직접 재실행하지는 못했다. 조건식·날짜 비교·Node requestTimeout 의미에 대한 보조 재현을 수행했다고 밝혔으며, 제출자의 57/57 통과와 자신의 실행 범위를 구분했다. Pro가 전체 서비스를 실행·검증했다는 뜻이 아니다.

| ID | 지적 | 수정 |
|---|---|---|
| R1 | 특정 규칙 skip이 무관한 산술 실패의 차단까지 해제 | skip의 범위를 해당 검사에 한정하고 전역 차단 해제는 force/warn만 허용 |
| R2 | 연혁 일부 실패가 정상 원문과 성공한 연혁까지 유실 | 원문과 역할별 연혁 상태를 분리하고 부분 결과/전체 deadline 실패를 보존 |
| R3 | 시행일을 UTC 날짜로 비교 | Asia/Seoul 날짜로 비교하고 비교 timezone 명시, 한국 자정 경계 네 시각 시험 |
| R4 | 서버 연결 10초+호출 45초에 비해 bridge 45초가 짧음 | 서버 연결+호출 총 45초, 연결에 쓴 시간을 차감, 정리까지 슬롯 유지, bridge 응답 60초 |
| R5 | upstream의 유의미한 오류 내용/구조화 정보가 API에서 유실 | 예상 도구 오류만 제한된 진단으로 보존, credential/내부 필드/trace 제거 및 크기 제한, REST/MCP 시험 |

추가 보완: SSE 스트림이 열려도 endpoint를 주지 않는 경우 전체 접속 deadline, 공백/줄바꿈까지 포함한 정확한 초안 hash, 게시 tarball의 npm-shrinkwrap과 실제 설치 버전 확인.

## 미완료와 배포 경계

Pro는 조회 전용 HTTPS 전환까지 AGY 완성을 기다릴 필요는 없다고 구분했다. 자동 수리·승인·게시·배포 실행기를 운영 entrypoint에 새로 연결하라는 요구는 없었다. DB 접수를 켜면 실제 migration/권한/복구 시험이 필요하고, 조회 전용 후보에서 접수를 닫는 선택은 허용했다.

운영 HTTPS DNS/터널/외부 3000 폐쇄와 안전한 조회 전용 rollback은 아직 미확인이다. 실제 DB migration/복원 및 전체 자기수정 흐름도 미완료이며 이번 결과로 production GO를 만들지 않는다.

1차 검수 중 GitHub push가 PAT의 workflow scope 부족으로 거부되었다. 실행 workflow를 `deploy/review.workflow.yml.example`로 보존해 나머지를 Draft PR에 게시했다. 원본 검수 입력과 게시 commit의 차이는 이 CI 파일 위치 및 그 사유를 밝힌 문서였고, 당시 runtime/test 코드의 차이는 없었다. **Linux CI는 실행되지 않았다.**

## 2차 검수

- 입력 commit: `4538471b7a7075aed23e97465c2054ef1202cac3`.
- [18개 파일의 수정 패킷](DEPLOYMENT_PRO_PACKET_2026-09-19_v2.md), SHA-256 `a1e36c77b0319f2dcccf7b32c704908103af7f0be8464b0bb3df454a06f72217`.
- 제출 당시 로컬 회귀 시험 64/64, 패키지 검사 6개 통과. 당시 artifact SHA-256 `e9e23ef9cc267cc309affa4fee8cedc6c4318804408579561ef94543d7e98c3d`. 이 artifact는 이후 코드 보완 전 버전이다.
- 7분 2초 처리 후 R1~R3 해소, R4~R5의 기존 직접 반례는 해소됐으나 아래 P2 두 건 잔여로 **CODE REVISE / 운영 HOLD**. 신규 P1 없음.
- Pro는 18개 파일 hash 일치와 합성 SDK/정화 함수 보조 재현을 확인했다. 실제 SDK/자식 프로세스 통합시험과 64개 전체 시험은 Pro 자신의 실행으로 주장하지 않았다.

| ID | 잔여 지적 | 후속 보완 및 재현 |
|---|---|---|
| A (R4) | 짧은 timeout의 요청이 이전 자식 정리 대기 중 만료되면, 슬롯을 먼저 반환하고 대기 작업이 나중에 새 자식을 생성 | 연결 확보 함수에 deadline 전달, 정리 대기 직후 재확인, 연결 확보·정리 종료까지 슬롯 유지. 실제 SDK 자식을 EOF 이후에도 살려 두는 fixture에서 수정 전 실패를 확인하고, 만료된 대기 요청의 슬롯 유지·추가 spawn 없음·새 요청의 정상 재접속을 시험 |
| B (R5) | 숫자형 LAW_OC와 JSON 문자열에 직렬화한 stack/비밀값이 응답에 잔존 | 값 타입에 무관한 credential 키 제거, 알려진 숫자형 비밀값 정화, JSON 문자열을 먼저 파싱한 뒤 동일한 재귀 필터 적용. 구조를 판별할 수 없는 혼합/이스케이프 문자열은 제외. 수정 전 실패와 수정 후 REST/MCP 진단 보존 및 비밀값 제거 시험 |

지원 설치기의 앱 루트 `npm ci`와 버전 일치 검증은 새 차단점으로 판정하지 않았다. 자동 worker 완성을 조회 전용 후보의 선행 조건으로 추가하지 않았다.

## 3차 한정 검수

- 입력 commit: `1fb66e176dba757452899db3fc21a8c5f8ce61dd`.
- [A/B 보완 6개 파일 패킷](DEPLOYMENT_PRO_PACKET_2026-09-20_v3.md), SHA-256 `9dc805d22c89ccce7a3b702f5473c4e33feb283953d3b3e0b15689c5db301191`.
- 제출 당시 로컬 `npm run review` 67/67, package 6개 검사 통과. 당시 artifact SHA-256 `9745e8f086a9d7b90e9985772b90952a321e5e0af17a1864f76d578086e96aea`는 아래 추가 보완 전 버전이다.
- 5분 57초 후 **B 해소, A의 기존 반례 해소 / 경합 P2 A-1 잔여**로 CODE REVISE·운영 HOLD.
- Pro는 패킷 및 6개 파일 hash 일치를 확인했다. 정화 함수 시험 3개를 직접 실행해 통과했고 추가 타입/혼합 문자열/크기 경계를 확인했다. 전체 npm·실제 SDK 통합시험·tgz 재해시는 직접 실행하지 않았다고 명시했다.

**A-1:** 정리 완료 시 이미 만료된 E의 acquisition은 오류를 던지지만, 아직 유효한 N이 그 사이 새 연결을 만들면 E의 catch가 전역 `this.connection`을 선택해 N의 연결을 종료한다. Pro가 실제 클래스와 합성 SDK/transport로 보조 재현했다.

후속 수정은 연결 확보 전 deadline guard를 `LawMcpError(504, MCP_TIMEOUT)`로 구분하여 전역 연결 정리 경로에 들어가지 않게 하는 것이다. 새 회귀시험은 이전 retirement 완료 시점만 제어하고, 새 자식은 실제 SDK/stdio로 기동한다. 이벤트 루프를 잠시 지연시켜 E만 만료되고 N은 유효한 순서를 만든다. 수정 전 N이 MCP_UNAVAILABLE로 실패했고, 수정 후 N이 정상 조회에 성공했다. 기존 슬롯 유지/고아 프로세스 방지 시험도 유지했다.

## 4차 한정 검수

A-1 보완 후 `npm run review` 최종 **68/68 통과**(실패·skip 없음). 첫 전체 실행에서는 별개의 기존 upstream 기동 시험이 10초 deadline으로 실패했다. 코드와 제한값을 바꾸지 않고 해당 시험만 다시 실행해 1.7초에 통과했고, 전체 재실행도 68개 모두 통과했다. 이 일시적 실패의 원인을 확정한 것은 아니며 Linux·운영 cold-start 검증은 여전히 필요하다.

- 최종 코드 commit: `e7ce0b2214c94dae1f3f2e96281b045635ddb4c5`.
- [A-1 한정 패킷](DEPLOYMENT_PRO_PACKET_2026-09-20_v4.md), SHA-256 `cbc95e0561fc90684321bb1a95f2a8cac77e5b69d10d93e3dad98798d5a2e94d`.
- 최종 `npm run review:package`: **6개 검사 통과**. artifact SHA-256 `08fe3e6d24a22d1d68e4db278b29d43d96f627339999a897423114b0a2cf7f61`.
- [검증 manifest](DEPLOYMENT_VALIDATION_2026-09-20.json)에 코드/패킷/설치 artifact hash, 실행 환경, 68개 회귀시험 및 패키지 검사 결과와 한계를 기록했다.

**3분 50초 후 최종 판정: A-1 해소, 해당 수정 범위의 잔여 P1/P2 없음, 조회 전용 제한 후보 CODE PASS / 실제 운영 배포 HOLD.**

Pro는 패킷 및 3개 파일의 hash 일치를 확인했고 v3 대비 실행 코드 변경이 guard 한 줄과 주석 두 줄뿐임을 직접 대조했다. 확보 전 만료 오류가 즉시 재전파 분기로 처리되어 다른 요청의 새 연결을 종료하지 않으며, 실제 timeout 시 retirement/acquisition 종료 대기와 슬롯 유지가 보존됨을 확인했다.

같은 합성 SDK/transport 보조 재현을 직접 실행해 v3의 정상 요청은 MCP_UNAVAILABLE, v4는 retrieval 성공으로 대조했다. 기존 A 시나리오도 통과했다. 실제 SDK/stdio 통합시험과 전체 68개, 최종 tgz 검증은 구현자의 실행 결과로 구분했다. 기동 timeout 한 번의 원인은 확정하지 않았고, 재실행 성공만으로 운영 기동 안정성을 보증하지 않았다.

운영 HOLD 사유는 실제 HTTPS·외부 TCP 3000 폐쇄·Linux CI/운영 cold-start·안전한 rollback·마지막 사람 검수 미확인이다. 접수를 켜면 운영 DB migration/권한/복원 확인도 필요하다. 닫힌 자동 worker/게시/배포 경로는 그대로 유지한다.
