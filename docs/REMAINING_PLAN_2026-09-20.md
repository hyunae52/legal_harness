# Legal Harness 남은 구현·운영 전환 계획

상태: v2 최종 — 별도 **6 Pro 재검수 PLAN PASS**, 권고 4개 반영·잔여 필수 수정 없음. [두 차례 검수 기록](reviews/REMAINING_PLAN_PRO_REVIEW_2026-09-20.md). 운영 HOLD는 유지되며, 이 문서는 실행 승인이나 배포 완료 선언이 아니다. 사용자의 마지막 일괄 검수·머지 방식을 유지한다.

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
   첫 실행은 소유자가 같은 PR 브랜치에 workflow를 push하여 발생하는 `pull_request`의 `synchronize` 이벤트로 고정한다. `workflow_dispatch`만으로 bootstrap할 수 있다고 가정하지 않는다. 실제 event/저장소 정책으로 시작되지 않으면 원인을 확인하며 main 선행 머지로 우회하지 않는다. [GitHub 이벤트 조건](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
5. GCE·Supabase·Actions·모델의 실제 계정 잔여 한도를 기록한다. 무료 사용 가능 여부를 상품 이름만으로 보증하지 않는다. GCE에는 조회 서비스와 작은 coordinator만 상주시키며 비신뢰 패치 시험은 두지 않는다.

산출물: 비밀값 없는 대상 inventory, 접근 가능/불가 목록, 실제 한도·자원 기록, 검수 가능한 배포/복구 명령안. 합격: 대상 식별과 복구 접근이 확인되고 자원 예산을 넘지 않는 시험 환경을 준비할 수 있음.

### A1. Linux CI·기동·설치·자원 시험

1. `deploy/review.workflow.yml.example`를 기반으로 Ubuntu 24.04 / Node 22의 정확한 patch 버전·runner image 정보를 기록하고 clean `npm ci` → `npm run review` → `npm run review:package`를 실행한다. Windows 증거와 Linux 증거는 별도로 보존한다. workflow와 검증기는 사람이 검수한 고정 revision을 사용한다.
2. secret 없는 ephemeral runner에서 검수한 head를 시험한다. 운영 DB/GitHub 쓰기/SSH/model credential을 넣지 않는다. action revision, producer, event, commit, 필수 step 결과를 provider API로 확인한다. workflow가 등록됐다는 것만으로 CI 통과로 세지 않는다.
   기록은 workflow revision, run ID/attempt/event, event의 식별자, 실제 checkout commit/tree, 테스트한 tree, 생성 artifact digest를 별도 필드로 남긴다. PR event의 기본 merge ref와 명시적으로 checkout한 H를 혼동하지 않고, build/test 대상과 승인 tree의 대응을 검증한다.
3. 대상 VM과 같은 Node/OS 및 자원 제한에서 공식 upstream의 cold-start 20회와 따뜻한 연결 호출을 시험한다. 각 시작은 기존 10초 제한 내 성공해야 한다. timeout·cleanup 지연·이벤트 루프 지연·CPU/RSS/자식 수를 기록하고 한 번이라도 실패하면 원인 확인 후 관련 수정/시험을 한다. 통과할 때까지 재실행한 마지막 결과만 제출하거나 제한을 임의로 늘리지 않는다.
4. 15분의 제한된 자원 시험: 합성 지연 upstream으로 3개 동시 작업, 초과 요청 429, timeout/연결 종료/재접속/종료 후 자식 정리를 검증한다. 실 법제처 조회는 실제 승인 quota 내 최대 20회로 제한한다. OOM/비정상 재시작/종료 후 고아 자식 0, 작업 종료 후 점유 슬롯 0, process group 합계 최대 RSS가 VM RAM의 70% 이내여야 한다. 부족하면 부하·worker 공존 계획을 줄여 다시 설계하고 자동 증설하지 않는다.
   A 전환 중 구형 앱+후보+각 upstream+cloudflared, B에서는 조회 앱+upstream+coordinator의 합산 점유를 각각 측정한다. 한 프로세스의 PM2 제한만으로 VM 전체 상한을 만족했다고 판단하지 않는다. RAM·디스크·runner 분·artifact 보관량의 실제 한도와 예약 상한도 실행 manifest에 기록한다.
5. 검수 artifact를 별도 디렉터리에 설치하고 앱 루트에서 lock 기반 `npm ci` 후 실제 의존성 버전을 대조한다. 깨끗한 Linux bridge와 Windows bridge에서 `doctor`, 도구 목록, 인증된 합성 호출을 확인한다. 서로 다른 실제 MCP 클라이언트 두 개의 표준 stdio 조회도 확인하고 지원표에는 시험한 조합만 적는다.
6. upstream 목록/기동이 정상인데 자료 조회가 실패하면 출처 장애로 따로 기록한다. `available`/`retrieval_only`/`unverified` 상태가 유지되는지 검사한다. 외부 자료 장애를 내부 테스트 통과나 법적 유효성 확인으로 바꾸지 않는다.

산출물: Linux CI run/step 증거, 20회 시작 기록, 자원·종료 시험, 설치·클라이언트 지원표, 후보 artifact manifest. 합격: 필수 검사 전부 실제 성공, 기동 원인 미확정 사항 해소, 위 상한 충족. 실패면 A2 준비는 계속하되 배포 후보는 HOLD.

### A2. 전환·복구를 먼저 준비하고 사람에게 한 묶음으로 제출

1. 후보를 별도 release 디렉터리/loopback 포트에 준비한다. secrets는 artifact 밖에 두며 app/rules/lock/upstream/config schema를 고정한다. 공개 route나 현재 프로세스를 아직 전환하지 않는다.
2. 격리된 route 또는 loopback/SSH 경로에서 앱 기동, header 인증, REST/SSE/messages, 정상 법령 조회, 연결 종료를 시험한다. cloudflared/DNS/방화벽 변경 명령과 적용 전후 기대 상태를 확정한다. 최종 공개 도메인의 성공은 실제 전환 후에만 관찰할 수 있으므로 사전 증거와 구분한다.
3. 무인 업데이트·옛 `/api/evolve`·`propose_tax_rule`을 비활성 상태로 유지한다. 신규 credential 누락/잘못된 key/query 인증/다른 actor 세션/허용되지 않은 Origin이 거부되는지 시험한다. 인증값은 URL·출력·녹화에 넣지 않는다.
4. 안전한 rollback 최저 조건은 HTTPS+loopback+header 인증+옛 자동 PR 경로 폐쇄다. 현재 운영 중인 구형 HTTP 앱을 복구 대상으로 쓰지 않는다. 기존 안전 release가 없다면 최초 전환의 실패 복구는 **검증한 HTTPS maintenance 503 상태**로 한다. 이 상태와 전환·복구를 사전에 시험하고 첫 배포의 무중단 복구를 보장한다고 쓰지 않는다. 첫 정상 A release를 확보한 뒤 다음 배포부터 그 artifact로 되돌린다.
5. 신뢰된 build가 검수 tree에서 artifact를 만들고 해시·실제 설치 의존성을 기록한다. 코드 리뷰 대상과 배포 artifact 연결, 이전 안전 artifact 또는 maintenance 절차, 변경 명령, 성공/중단 기준을 PR에 넣는다. 미완료 자기수정 기능은 활성화 항목에 포함하지 않는다.
   A에 필요한 최소 build·배포·복구 실행 경로는 이 단계에서 고정된 검수 스크립트/운영자 명령으로 완성·시험하며 B4가 이를 재사용·확장한다. 다른 artifact·설정·merge tree를 주입하면 공개 전환 전에 거부되는지, 승인 후보의 실패에서 준비한 복구가 실행되는지 확인한다.
6. 사람은 **현재 B/H/T, manifest, 배포·복구 절차와 전환 후 자동 판정 조건을 한 번 최종 검수**한다. 이때 준비 작업을 마친 reviewable 결과를 제시한다. 계획 검수 응답만으로 이 승인을 대신하지 않는다. head/base/tree 또는 승인 대상 설정·artifact가 바뀌면 기존 승인을 재사용하지 않는다.

### A3. 승인 후 실행할 운영 전환 및 판정

1. 검증기에서 승인 B/H/T와 실제 merge M의 부모/내용 tree를 대조한다. M SHA가 H와 같을 것을 요구하지 않는다. A에서는 A2에서 시험한 운영자/Codex의 배포 명령과 신뢰된 검증 스크립트가 필수 CI·review 증거·artifact digest를 확인하고 정확한 artifact를 사용한다. 현재 읽기 검증기의 `deployment_authorized:false`를 GO로 해석하지 않으며, 자동 배포기 완성은 B4의 별도 작업이다. 사람이 이미 승인한 동일 묶음에 M만 새로 생겼다는 이유로 별도 재승인을 요구하지 않는다.
2. loopback 후보 정상 상태 → Linux cloudflared route 전환/DNS 정상화 → 외부 HTTPS header 인증 실제 조회 → 같은 배포 창에서 외부 TCP 3000 ingress 폐쇄 및 구형 listener 종료 → 독립 외부 네트워크 확인 순서로 수행한다. SSH 복구 경로는 유지한다. 구형 클라이언트 전환을 무기한 기다리지 않는다.
3. 전환 시작 후 15분 안에 최종 HTTPS 정상/인증 거절 시험 및 public IPv4·사용 중인 IPv6의 3000 차단을 확인한다. 자동 합격은 `/health`의 검수 버전·fingerprint 일치, 인증된 실제 MCP 호출, 음성 인증·session 시험, 외부 HTTP 차단, 서비스 재시작 후 동일 동작을 모두 요구한다. 단순 health 200은 충분하지 않다.
4. 실패하거나 관찰 불능이면 GO를 내지 않는다. 공개 3000을 닫고 이전 안전 HTTPS release 또는 사전 검증 maintenance 상태로 복구한다. DNS/터널 설정은 안전 경계가 유지되는 확인된 상태로만 되돌리며 공개 HTTP를 재개방하지 않는다. 복구 실패/상태 불명은 자동 재시도·재전환을 중단하고 명확히 알린다.
   DNS/터널 장애로 외부 503까지 확인할 수 없으면 `public_port_closed / service_unavailable / recovery_unverified`로 기록한다. 관찰하지 못한 maintenance 503을 복구 성공이라고 쓰지 않는다.

사전 상태는 `READY_FOR_HUMAN`, 전환 중은 `VERIFYING`, 실제 후속 검증 성공 후에만 `A_LIVE_VERIFIED`다. 최종 도메인 성공을 승인 전 반드시 실행해야 하는 순환 조건으로 만들지 않는다. A 완료 보고에는 DB/worker 미활성 및 B 미완료를 함께 적는다.

## 5. 출시 B — 사용자가 원한 자기수정 기능 완성

다음 작업은 A 준비와 독립적으로 구현할 수 있다. 실제 운영 활성화는 각 단계 증거와 최종 B batch 승인을 요구한다.

### B1. Supabase 접수·근거 저장 기반

- 기존 `profiles`/`evolution_logs`/migration 이력과 추가 DDL를 대조한다. 기존 데이터·auth UUID는 유지하고 expand-only migration을 준비한다. Supabase의 `auth.users`를 별도 사용자 테이블로 재생성하지 않는다.
- 격리된 PostgreSQL/Supabase 시험에서 실제 anon/authenticated/server-only 역할, API actor/JWT 소유권, 과거 직접 INSERT 폐쇄, RPC 원자성, idempotency payload 충돌, queue 한도, fenced lease·오래된 worker 거절을 검증한다. PGlite 통과를 실제 Supabase 증거로 대체하지 않는다.
- 백업을 암호화하고 격리 복원 후 행 수/참조·권한·schema 호환을 검증한다. 목표 RPO 24시간/RTO 4시간은 실제 복구 시험으로 확인하며 달성 전 보장이라고 쓰지 않는다. GitHub 외부 효과는 DB 복원만으로 취소되지 않으므로 intake/worker/publisher를 중지하고 intent·branch·PR을 대조한 뒤 재개한다.
- 무료 계정의 실제 백업 실행안에는 검증한 export 명령·도구 버전(예: Supabase CLI `db dump`), 예약 실행 위치, 대상 schema/역할·auth 포함 범위, 암호화 키의 별도 복구 절차, DB와 다른 장애 영역의 보관 위치·용량·보존기간을 넣는다. 보관처와 키 복구까지 확인한 격리 복원을 요구하며 백업 평문을 GitHub/AI에 보내지 않는다. Supabase Storage 객체를 실제 사용한다면 별도 객체 백업을 검증하고, 미사용이면 범위를 추가하지 않는다. [Supabase 백업 범위](https://supabase.com/docs/guides/platform/backups).
- 복원 시험에는 **백업 후 생성된 PR/runner는 남고 DB의 intent/job 행은 사라지는 경우**를 넣는다. 복원된 행만 조회하지 않고 관리 namespace의 외부 branch/PR/run과 별도 보존한 신뢰 journal/제공자 사용기록을 대조하여 작업·시도 신원과 보수적인 예산을 복원한다. 외부 metadata 자체를 승인 증거로 삼지 않는다. 대조 불능이면 유지보수 쓰기를 보류하고 새 job/새 예산으로 중복 게시하지 않는다.
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
- allowlist 검사 외에 실행 중 신뢰 fixture·검증기·집계 결과를 덮어쓰려는 합성 패치를 투입하여 변조가 차단되는지 확인한다. 비신뢰 작업의 artifact를 권한 있는 후속 작업에서 그대로 실행하지 않는다. [GitHub의 비신뢰 코드·artifact 경계](https://docs.github.com/en/actions/reference/security/secure-use).
- 합성 public packet을 최초 외부 전송 전에 검사한다. base와 patch에 동일한 신뢰 fixture를 실행하여 **해당 원인의 RED → GREEN**을 확인한다. base의 설치 오류/timeout은 재현 성공이 아니다. 새 시험은 별도로 검수하고 기존 시험 삭제·약화로 통과할 수 없다.
- 실제 별도 AI에는 diff, 근거, correction, 재현·gate 결과와 정확한 hashes를 보낸다. 기존 `ReviewVerdictSchema`의 `approved / changes_requested / needs_evidence / unavailable` strict 결과·producer·요청 ID·세션을 기록한다. 임의의 `approve/revise/reject` alias를 승인 enum으로 받지 않는다. 빈 출력/형식 불량/불일치/기한 만료는 승인되지 않는다. 수정하면 이전 verdict는 무효이며 동일 절차를 다시 통과한다.
- worker concurrency 1, job lease 45분 및 fencing, 최대 패치 시도 3회, 모델 1회 최대 10분, 하루 모델 호출 최대 20회와 실제 계정 quota 중 더 작은 한도를 적용한다. 허용된 시간·토큰·반복 예산은 DB에서 원자 예약/누적한다. 재시작·lease 회수·동일 semantic fingerprint로 예산이 초기화되지 않아야 한다. 장기 호출은 lease heartbeat 및 취소·오래된 결과 차단을 시험한다.
- lease 45분은 작업 전체 상한과 구분한다. 첫 작업 전체 wall-clock 상한은 45분, runner 1회 상한은 15분으로 두고 실제 모델/runner 계정의 더 작은 한도를 우선한다. 재시도·heartbeat로 전체 deadline이 초기화되지 않는다. 조정이 필요하면 측정 결과와 변경값을 검수 manifest에 포함한다.
- **모델/runner 수락 후 응답 유실 → timeout → lease 교체**를 시험한다. attempt/operation/provider run ID를 추적하고 이전 세대 결과는 승인·게시하지 않는다. timeout/lease 만료만으로 원격 종료나 미사용을 가정하지 않으며 사용량 예약을 보수적으로 유지한다. 취소 후 provider terminal 상태/로컬 process group 종료를 대조하고, 원격 상태가 불명이면 관련 실행 슬롯을 새 호출에 재사용하지 않고 보류한다. 재호출은 대조 후 새로운 시도로 별도 차감하며, 모델 추론 자체의 exactly-once를 보장한다고 쓰지 않는다.
- outbox의 operation intent/고정 branch/exact commit을 먼저 기록하고 GitHub의 실제 branch/PR을 대조한다. 외부 쓰기 성공 여부가 불명확하면 재전송하지 않고 보류·대조한다. DB rollback으로 이미 생성한 PR을 없었던 것으로 보지 않는다.

합격: fake port가 아닌 실제 경로로 **코드 결함 1건 + 규칙 결함 1건**을 합성 입력→base 재현→패치→독립 AI 검수→실제 CI→draft PR까지 완료한다. 또한 형식 불량/모델 quota/runner 실패/lease 중복/DB 복원/PR 작성 응답 유실 시 거짓 승인·중복 게시 0을 확인한다. 모든 commit·path·로그·PR metadata·artifact·모델 입출력의 synthetic private canary 반출을 시험한다. canary 통과를 모든 개인정보 자동 익명화의 증명으로 쓰지 않는다.

추가 실패 주입 합격 기준: 실행 중 fixture/집계 변조가 통과하지 않음, 응답을 잃은 구세대 결과로 승인되지 않음, 원격 작업이 살아 있거나 불명인데 새 실행을 허용하지 않음, DB에 없어진 intent를 외부 효과와 대조하지 않은 채 중복 PR을 만들지 않음, 복원 전 소비량을 새 일일 한도로 초기화하지 않음. 외부 상태·예산의 신뢰 가능한 복원이 불가능하면 명시적 HOLD가 정답이며 가짜 복구 성공을 요구하지 않는다.

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
