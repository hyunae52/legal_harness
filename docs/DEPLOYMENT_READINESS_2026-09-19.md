# 수정본 배포 검수 자료

기준: main `d41e4588ecd374eedf5a7a846942ce27a17bf7f5` 이후 작업 브랜치 `fix/reviewed-deployment-20260919`.
이 문서는 계획의 완료 선언이 아니다. 별도 Pro에는 구현·시험·환경 미확인을 구분해 제출한다.

## 구현한 수정

- Express 생성/실행 분리, native ESM 테스트, 인증된 REST/SSE/messages 공통 경계, 실제 작업 수명 기준 동시 실행 제한.
- 공개 URL을 HTTPS로 통일, loopback만 바인딩, 헤더 인증, query key/내장 key 폐쇄. 의존성 포함 tarball 설치 및 doctor.
- 원본 MCP 결과 보존, 근거 메타데이터, 새 upstream 프로세스로 법령 이름/시행일/연혁 재조회, 제한된 stale fallback.
- FC-01~10의 누락 사실 질문, 미검수/검사 범위/초안 hash, 별도 산술 검사. 논쟁적인 배분 법리를 참이라고 하드코딩하지 않음.
- 과거 logs를 보존하는 추가 SQL, 단일 RPC의 실패·job·outbox 접수, API actor/JWT 경계, idempotency와 fenced lease.
- mock 승인/가짜 PR 경로 폐쇄. 독립 검수 strict JSON/timeout/hash, 자동 패치 파일 범위와 실제 테스트 증거 계약. 이 부분은 아직 포트 테스트 수준이며 worker 미연결.
- cron은 후보 준비만 수행. 승인 fingerprint로 수동 활성화/rollback. GitHub CI 설정안과 읽기 전용 B/H/T·merge·artifact·실제 step 검증.

## 확인한 시험

- 기존 baseline: 42개 중 28 통과 / 14 실패. 테스트의 VM loader와 새 ESM import 불일치.
- 로컬 `npm run review`: 최종 **68/68 통과**, 실패·skip 없음. `npm run review:package`는 실제 설치된 의존성 버전이 lock과 일치하는지 포함해 6개 항목을 확인한다. 최종 코드 commit·패킷·artifact hash 및 검사 결과와 독립 검수의 범위는 [별도 Pro 결과](reviews/DEPLOYMENT_PRO_REVIEW_2026-09-19.md)에 기록한다. upstream 기동의 일시적 timeout 1회와 동일 조건 재실행 통과도 기록했다.
- 법제처 live 읽기: 근로기준법 `001872`, upstream `4.13.0`, 공포일 `20260219`, 시행일 `20260820`, 사건일 `2024-01-01` 연혁 요청 1건. 접근 available, 버전 current_candidate, 적용 판단 unverified. 내용 SHA-256 `76f7ea77be0755c253894d50905b4f9ef04d7906c1648a1ffb9c7bfa6f32f458`.
- PostgreSQL 검증은 PGlite의 모사된 Supabase 역할/권한에서 수행. 운영 DB에 적용했다는 뜻이 아니다.
- 패키지 시험은 빈 경로 설치 + 실제 SDK transport + 로컬 합성 서버. 공개 HTTPS가 작동한다는 뜻이 아니다.

## 아직 완료하지 못한 배포 조건

GitHub의 기존 PAT에는 workflow scope가 없어 Actions 파일 push가 거부되었다. 기존 SSH 계정과 연결된 GitHub 앱도 해당 저장소 쓰기 권한이 없다. 권한을 늘리지 않고 `deploy/review.workflow.yml.example`로 설정안을 보존했다. `.github/workflows/review.yml` 등록과 실제 Linux CI 실행도 배포 선행 조건이다. 로컬 Pro 입력 commit `7309a37`은 `review/pro-input-20260919` 태그에 보존한다.

1. **운영 HTTPS:** 실제 GCE의 cloudflared 서비스, Cloudflare DNS/인증서, 기존 외부 TCP 3000 폐쇄를 적용·확인해야 한다. 로컬 코드 변경만으로 해결됐다고 하지 않는다. 이전 점검에서 `law.taxlab.kr` DNS 실패 및 기존 IP HTTP 응답을 관찰했다.
2. **운영 DB:** 실패 접수를 활성화하려면 실제 기존 schema/migration 이력 확인, 추가 migration, server-only DB credential 설정, 암호화 백업과 격리 복원/외부 GitHub 효과 대조 시험이 필요하다. 조회 전용으로 먼저 전환할 때는 `SUPABASE_SERVICE_ROLE_KEY`를 설정하지 않아 접수를 닫고, `/health`의 maintenance 상태가 `unavailable`인지 확인한다. 이 경우 운영 DB 변경은 해당 제한 배포의 선행 조건이 아니다.
3. **실제 자기수정:** AGY의 도구 실행 차단·모델 인증만 있는 격리 호출 환경, hosted runner의 고정 fixture RED/GREEN 수집, coordinator/outbox 연결과 일일 budget/재시도/회복을 구현·실증해야 한다. `evolution.ts`의 주입 port와 단위시험만으로 완료되지 않는다. 운영 entrypoint에서는 이를 연결하지 않았다.
4. **근거 저장/검수 범위:** 근거·초안 검수 영속 저장/무효화, 관련 예규의 후속 변경과 부칙/적용 판단은 미구현이다. 현재 응답은 이 한계를 명시한다.
5. **사람 승인과 배포:** 현재 release gate는 provider evidence를 읽어 식별자와 CI 실행을 대조할 뿐, 신뢰된 artifact build/원격 활성화·rollback 또는 실제 배포 허가를 수행하지 않는다. 코드/규칙 각각 1건의 live self-repair와 최종 human batch 시연도 남았다.

현재 배포 판단: **전체 목표의 production GO를 주장할 수 없음**. HTTPS·인증·mock 폐쇄를 먼저 적용하는 제한 배포도 실제 HTTPS, 환경설정, 회귀·rollback 증거와 사람의 마지막 검수 이후에만 진행한다. 키 회전이나 유료 서비스 추가를 이번 수정의 선행 조건으로 요구하지 않는다.

## 운영 적용 순서

1. 이 브랜치의 검수 결과와 변경 commit을 묶어 사람이 review한다. 기존 자동 PR은 별도로 merge하지 않는다.
2. 실패 접수를 활성화하는 배포는 운영 DB backup/migration 이력을 확보하고 격리 복원에서 추가 DDL과 권한을 검증한다. 조회 전용 배포는 DB 쓰기 접수를 비활성화한 상태를 확인한다. 기존 데이터 삭제로 migration을 맞추지 않는다.
3. 승인한 앱/rules/lock/upstream 묶음을 별도 release 디렉터리에 설치한다. `.env`는 배포 artifact에 포함하지 않는다.
4. 별도 loopback 포트에서 인증·SSE·기존 클라이언트 bridge·공식 법령 조회를 확인한다. old `/api/evolve`를 되살리는 rollback은 허용하지 않는다.
5. cloudflared 연결을 검증한 뒤 터널의 backend를 전환하고 외부 TCP 3000 ingress를 닫는다. 외부에서 HTTPS 인증 성공과 HTTP 포트 차단을 확인한다.
6. 실패 시 이전 **안전한 조회 전용** release로 복원한다. 앱 rollback으로 SQL까지 복원됐다고 하지 않는다. DB restore가 필요하면 외부 쓰기를 중지하고 GitHub 기존 효과를 대조한 후 재개한다.

운영 서버 변경·DB migration·merge는 이 문서 작성이나 로컬 테스트로 실행되지 않았다.
