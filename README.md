# Legal Harness

사용자의 LLM이 공식 `korean-law-mcp`를 조회하고, 제출한 초안의 확인 범위와 누락 사실을 구분할 수 있게 하는 Express/MCP 서버입니다. upstream은 npm 패키지를 **별도 stdio 자식 프로세스**로 실행합니다. 원본 파싱 코드를 복사하거나 포크하지 않습니다. 일반 조회에는 서버의 LLM 키가 필요 없습니다.

현재 수정본은 **운영 배포 전 검수 대상**입니다. 자동 패치 전체 루프는 아직 활성화하지 않았습니다. [배포 상태 및 남은 조건](docs/DEPLOYMENT_READINESS_2026-09-19.md)을 먼저 확인하세요.

## 실행과 인증

Node.js 22 이상을 사용합니다.

```sh
npm ci --ignore-scripts --omit=optional
npm run review
npm run review:package
```

`.env.example`을 `.env`로 복사하고 `LAW_OC`, 기존 `TAXLAB_API_KEY`를 설정합니다. 사용자 JWT를 사용할 때는 Supabase URL과 publishable/anon key도 설정합니다. 실패 접수에는 서버 전용 `SUPABASE_SERVICE_ROLE_KEY`와 아래의 추가 migration이 필요합니다. 이 값은 MCP 클라이언트에 전달하지 않습니다.

```sh
npm start
```

서버는 `127.0.0.1:3000`에만 바인딩합니다. Linux의 cloudflared는 [systemd 예시](deploy/cloudflared.service.example)와 [터널 설정](deploy/cloudflared.yml.example)을 사용합니다. DNS와 터널 연결 확인 후 GCE의 외부 TCP 3000 접근을 차단해야 HTTPS 전환이 완료됩니다. 설정 예시 작성만으로 실제 DNS/방화벽이 변경되지는 않습니다.

인증은 `x-api-key` 또는 `Authorization: Bearer` 헤더로 보냅니다. Bearer는 기존 공유 key 또는 Supabase가 확인한 사용자 JWT를 받습니다. URL의 `?apiKey=`는 거부하며 내장 기본 key도 없습니다. 공유 key는 `api:partner` 한 주체이므로 개인별 비공개 기록을 구분하지 않습니다.

## LLM의 MCP 연결

원격 SSE는 `https://law.taxlab.kr/sse`입니다. 헤더 인증을 지원하지 않는 클라이언트에는 로컬 stdio bridge를 사용합니다. **bridge 파일 한 개만 복사하면 의존성이 빠지므로 작동하지 않습니다.** 검수한 npm tarball을 설치해야 합니다.

```sh
npm run build
npm pack --ignore-scripts
bash scripts/install-mcp.sh /absolute/path/k-tax-agent-backend-2.2.0.tgz
```

Windows에서는 `scripts/install-mcp.ps1 -Package C:\Downloads\k-tax-agent-backend-2.2.0.tgz`를 실행합니다. 설치기는 MCP 설정 예시를 출력하며 기존 클라이언트 설정을 덮어쓰지 않습니다. 클라이언트에 `TAXLAB_SERVER_URL=https://law.taxlab.kr`과 기존 key 또는 `TAXLAB_AUTH_TOKEN`을 설정합니다. 설치된 bridge를 `node <bridge-path> --doctor`로 점검할 수 있습니다. 진단은 공개 상태와 인증된 도구 목록만 확인합니다.

## 조회·검증 계약

`GET /api/tools`에서 실제 upstream 도구와 입력 스키마를 확인합니다. `POST /api/analyze` 예:

```json
{"query":"근로기준법","tool":"search_law","arguments":{"display":1}}
```

`legal_research`, `search_law`, `search_decisions`는 `query`를 전달하고 다른 도구는 `arguments`를 그대로 전달합니다. 원본 `content`, `structuredContent`, `_meta`를 보존합니다. 조회 성공은 최종 답변이나 법률 적용의 검수 통과가 아닙니다. `draft_answer`가 없으면 `quality_gate`는 `null`입니다.

MCP `check_legal_sources` 또는 `POST /api/sources/check`:

```json
{"law_name":"근로기준법","law_id":"001872","event_dates":{"contract":"2024-01-01"}}
```

매 확인마다 새 upstream 프로세스로 원문과 역할별 사건일 연혁을 조회합니다. 법령 이름을 대조하고 공포일·시행일·내용 hash와 조회 시각을 반환합니다. 접근 실패 시 24시간 이내 이전 결과를 나이와 함께 표시하며 현재 결과로 바꾸지 않습니다. 전체 확인은 32초, 동시 refresh는 1개입니다. **부칙 해석·예규의 후속 변경·사건 적용 판단은 여전히 `unverified`**입니다. 현재 fallback은 메모리 안에서만 유지됩니다.

MCP `validate_legal_draft` (`validate_tax_draft` 호환 별칭) 또는 `POST /api/validate`:

```json
{"draft_answer":"권리가액과 분담금의 안분을 검토한다.","facts":{}}
```

FC-01~10의 키워드는 필요한 사실을 묻는 데만 사용합니다. 누락은 `needs_info`, 사실을 모두 받더라도 공식 근거를 확정하지 못한 법률 판단은 `unverified`입니다. FC-08~10의 논쟁적인 원가배분 방식을 확정 법리로 넣지 않았습니다. 별도의 `facts.allocation={"total":100,"parts":[40,60]}` 검사는 제출된 수치 합계만 계산합니다.

`assessment_complete`, `scoped_pass`, `coverage`, 초안/사실 hash를 반환합니다. 빈 검사 집합은 `no_coverage`이며 법률 전체의 기존 `passed`는 항상 false입니다. skip/force/warn에는 이유가 필요하고 완료된 실패 결과를 성공으로 바꾸지 않습니다. 답변이 바뀌면 다시 검사해야 합니다. 임의 LLM의 최종 출력을 강제로 통제하는 기능은 없습니다.

## 실패 접수와 Supabase

순서대로 적용할 migration:

1. `supabase/migrations/202609140001_profiles_evolution_logs.sql`: 기존 profiles/과거 기록 및 Auth 트리거.
2. `supabase/migrations/202609190001_durable_failures.sql`: actor·failure·job·outbox·event, 단일 트랜잭션 접수, 권한 회수, lease/fencing.

Supabase의 `auth.users`는 직접 만들지 않습니다. 기존 `evolution_logs`는 보존하고 신규 직접 INSERT 권한은 닫습니다. 기존 테이블이 있으면 초기 migration을 재실행하지 말고 실제 migration 이력과 구조를 확인하세요. 두 번째 migration은 추가 변경이며 SQL 오류 시 전체 rollback됩니다.

MCP `submit_failure` 또는 `POST /api/failures`는 공개 합성 사례 식별자와 enum만 받습니다. 원본 사건 서술/개인정보는 받지 않습니다.

```json
{"request_id":"00000000-0000-4000-8000-000000000001","case_id":"FC-09","category":"validation","expected":"needs_info","actual":"passed"}
```

응답의 `receipt_id`로 `GET /api/failures/:id`를 조회합니다. 동일 actor/ID/내용은 같은 접수로 돌아오고 같은 ID의 다른 내용은 409입니다. DB 실패는 503이며 저장되지 않은 접수를 성공으로 돌려주지 않습니다. 오래된 `/api/evolve`와 `propose_tax_rule`은 410입니다.

`/health.maintenance`는 `intake_only` 또는 `unavailable`입니다. 접수·테스트용 상태 전이 코드가 있어도 실제 AI/runner/coordinator가 연결된 것은 아닙니다. 검수 부재/시간 초과/형식 오류는 승인하지 않습니다. 별도 Pro 검수도 자동 maintenance adapter의 실증과는 구분합니다.

## upstream 업데이트와 배포

서버에서만 `KOREAN_LAW_MCP_RELEASE_FILE`을 설정하고 최초에 `bash scripts/update-korean-law.sh --bootstrap`으로 별도 설치본을 준비합니다. [cron 예시](deploy/korean-law-update.cron.example)를 설정하면 새 버전은 설치·review·MCP schema 확인을 거친 **후보**로 남습니다. cron은 운영 프로세스를 재시작하거나 후보를 활성화하지 않습니다.

사람이 후보 fingerprint를 포함한 검수 묶음을 승인한 후에만 `bash scripts/update-korean-law.sh --activate <approved-sha256>`를 실행합니다. 활성화 전 설치 파일 전체와 lock을 다시 hash하고 재검증합니다. 실패 시 이전 버전으로 복원하며 복원도 실패하면 journal을 보존하고 운영자의 복구가 필요합니다. 첫 bootstrap과 수동 활성화는 운영자 명령이며 자동 사람 승인 확인 기능을 대체하지 않습니다.

`npm run release:verify -- manifest.json artifact.tgz <approval-comment-id>`는 GitHub에서 운영자의 정확한 manifest 승인, B/H/T, merge 부모/tree, 실제 CI job/step, artifact hash를 읽어 대조합니다. **현재는 읽기 전용 식별 검증이며 배포 허가나 배포 실행기가 아닙니다.** DB 복원·실행 환경·staging/rollback 증거가 없으면 운영 배포 준비 완료로 표시하지 않습니다. PR은 모아 최종 사람이 검수하고 merge합니다.

CI 설정안은 [deploy/review.workflow.yml.example](deploy/review.workflow.yml.example)에 있습니다. 현재 GitHub 토큰의 workflow 권한 부족으로 게시가 거부되어 실행 파일로 등록하지 않았고 **Linux CI는 미실행**입니다. 운영자가 검수 후 `.github/workflows/review.yml`로 등록하면 GitHub-hosted Linux에서 읽기 권한으로 테스트하며 production secrets를 전달하지 않습니다. [GitHub workflow 권한 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)를 따릅니다. 일반 CI 통과만으로 독립 AI 승인이나 배포 승인을 만들지 않습니다.

## 검증

`npm run review`는 API/auth/session, 실제 stdio와 설치된 upstream 연결, PGlite SQL/RLS/transaction, 후보 활성화/rollback, 근거 상태, 독립 검수 경계 및 merge 검증을 확인합니다. 주입된 model/runner/GitHub port 테스트는 실서비스 AI 실행 증거가 아닙니다.

`npm run review:package`는 실제 npm tarball을 빈 prefix에 설치하고 stdio→SSE→인증 API, doctor, 포함된 rules를 검사합니다. `node scripts/source-smoke.mjs --live`는 설정된 법제처 인증으로 공개 근로기준법과 사건일 연혁을 실제 조회합니다.

검증하지 않은 범위: Linux 운영 배포, 실제 Supabase migration/복원, 공개 HTTPS와 외부 3000 폐쇄, 격리된 AGY와 hosted patch executor, 무인 self-repair, 사람 승인 후 artifact 활성화/rollback 전체 흐름. 최신 상태는 배포 검수 문서에 기록합니다.
