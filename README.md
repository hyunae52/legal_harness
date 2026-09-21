# Legal Harness

2.3의 새 MCP 주소는 `https://law.taxlab.kr/mcp`입니다. Streamable HTTP와
접속키 헤더를 지원하는 클라이언트에서 사용하며 기존 `/sse`와 설치파일도
유지합니다. 사건 연구는 빠진 필수 사실을 하나씩 묻고 `answer_legal_question`으로
답변·모름을 기록합니다. 추가 서버 LLM 키는 필요 없습니다.

보호 한도는 유지됩니다. 기본값은 실제 작업 3개, 전송 연결 전체 20개/인증 주체별
5개, 연구 전체 50개/주체별 5개(30분)입니다. 새 요청별 전송은 응답이 끝나면
연결 자원을 반환합니다. 요청 토큰은 전체 600/주체별 180, 조회 토큰은 120/60의
용량과 분당 충전량을 사용합니다. 공유키를 쓰는 사람들은 한 주체로 계산됩니다.
가입자 수를 세는 정책은 아닙니다. [구현·검증 계약](docs/TRANSPORT_INTERVIEW_PLAN.md)을 참고하세요.

사용자의 LLM이 공식 `korean-law-mcp`를 조회하고, 제출한 초안의 확인 범위와 누락 사실을 구분할 수 있게 하는 Express/MCP 서버입니다. upstream은 npm 패키지를 **별도 stdio 자식 프로세스**로 실행합니다. 원본 파싱 코드를 복사하거나 포크하지 않습니다. 일반 조회에는 서버의 LLM 키가 필요 없습니다.

법령 조회 서버는 **https://law.taxlab.kr**에서 운영합니다. 대화 중 반박·새 근거로 답변을 정정하면 공개 가능한 교정 자료를 준비하고, 사용자의 동의 후 실제 draft PR을 만드는 경로를 제공합니다. 최종 검수·머지는 사람이 합니다. 실행 코드 자동 패치·독립 AI worker는 별도이며 전체 B 파이프라인의 완료를 뜻하지 않습니다. [이전 배포 준비 기록](docs/DEPLOYMENT_READINESS_2026-09-19.md)과 [남은 구현 계획](docs/REMAINING_PLAN_2026-09-20.md)은 해당 작성 시점의 기록입니다.

## 사용자가 연결하는 방법

[연결 안내 페이지](https://law.taxlab.kr/)에서 앱을 고르세요. 사용자에게 필요한 것은 운영자에게 받은 **TaxLab 접속키**입니다.

- **Claude PC 앱**: [설치파일](https://law.taxlab.kr/downloads/taxlab-law.mcpb)을 확장 설정에서 설치하고 접속키를 입력합니다. SDK 의존성이 함께 들어 있으며 앱 내장 실행 환경을 사용합니다. 웹·모바일로 자동 연결되지 않습니다.
- **Claude 웹**: 일부 조직에 제공되는 Request headers 인증 베타 메뉴가 있으면 `/sse`와 `x-api-key`를 설정할 수 있습니다. 메뉴가 없는 계정은 현재 직접 연결할 수 없습니다. OAuth Client Secret에 접속키를 넣지 않습니다.
- **ChatGPT 웹**: GPT 만들기가 가능한 계정에서 [OpenAPI 설정](https://law.taxlab.kr/openapi.json)을 가져와 GPT Actions의 API Key/Bearer 인증을 설정합니다. [GPT 지침](https://law.taxlab.kr/downloads/chatgpt-instructions.txt)을 넣고 나만 사용으로 저장합니다. 모든 데스크톱 앱에서 같은 GPT의 Actions가 실행된다고 보장하지 않습니다.
- **ChatGPT 데스크톱**: Settings → MCP servers 메뉴가 있는 앱은 [로컬 bridge ZIP](https://law.taxlab.kr/downloads/taxlab-bridge.zip)을 풀고 STDIO로 등록합니다. 실행환경은 별도 필요하며 [설정 템플릿](https://law.taxlab.kr/downloads/chatgpt-desktop.toml)과 setup.md에 경로·접속키 전달 방법이 있습니다. `/sse` 주소를 Streamable HTTP 칸에 넣는 방식은 지원하지 않습니다. 메뉴가 없으면 웹 Actions를 사용합니다.
- **Gemini CLI**: [설정 예시](https://law.taxlab.kr/downloads/gemini-settings.json)를 `~/.gemini/settings.json`에 병합하고 `TAXLAB_API_KEY`를 로컬 환경에 설정합니다. 일반 Gemini 웹·모바일은 국내 일반 계정에서 현재 연결 불가이며, 공식 지역 조건에 해당하더라도 TaxLab 인증 호환은 미검증입니다.
- **Antigravity**: [전용 설정](https://law.taxlab.kr/downloads/antigravity-mcp.json)의 `serverUrl`·`headers`를 사용합니다. Gemini CLI의 `url`과 구분합니다. 앱의 Open MCP Config/View raw config에서 연 파일에 병합하고 Refresh합니다. 최신 공식 전역 경로는 `~/.gemini/config/mcp_config.json`, 프로젝트 경로는 `.agents/mcp_config.json`입니다.
- **PC 설정이 가능한 AI 에이전트**: 페이지의 ‘AI 설정 요청문’을 복사하세요. [setup.md](https://law.taxlab.kr/setup.md)에 기존 설정 보존, 비밀값 입력, 앱별 연결 범위와 확인 절차가 있습니다.

다른 MCP 앱에서는 `https://law.taxlab.kr/sse`와 `Authorization: Bearer YOUR_API_KEY` 또는 `x-api-key: YOUR_API_KEY`를 사용합니다. 접속키를 URL에 붙이지 마세요. 현재 Streamable HTTP와 OAuth 로그인은 제공하지 않으므로 모든 앱에 URL만 등록해서 연결되는 것은 아닙니다. 서버 운영 절차는 아래 별도 항목을 참고하세요.

`npm run build`는 `desktop/manifest.json`과 검수된 bridge 및 설치된 SDK 의존성으로 `dist/downloads/taxlab-law.mcpb`를 생성합니다. 접속키는 포함하지 않으며 Claude의 민감값 입력 설정으로 받습니다. 직접 배포한 확장은 새 버전 배포 시 다시 설치합니다. 자동 시험은 저장소 밖 빈 디렉터리에서 설치파일을 풀어 실제 stdio→SSE 호출까지 확인합니다. 실제 Claude UI 설치와 ChatGPT 계정별 GPT 편집기 동작은 별도 확인 범위입니다.

게시 패키지의 의존성은 `npm-shrinkwrap.json`으로 고정합니다. 제공 설치기는 tarball 설치 후 앱 디렉터리에서 `npm ci`를 실행해 이 고정을 적용합니다. 의존성을 변경할 때 `package-lock.json`과 함께 갱신해야 하며, package 시험이 두 파일의 일치 및 실제 설치 버전을 확인합니다.

## 서버 직접 실행과 인증

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

원격 SSE는 `https://law.taxlab.kr/sse`입니다. 로컬 프로그램 실행(stdio)만 지원하는 클라이언트에서는 Node.js 기반 bridge를 사용할 수 있습니다. **bridge 파일 한 개만 복사하면 의존성이 빠지므로 작동하지 않습니다.** SDK 의존성이 포함된 [bridge ZIP](https://law.taxlab.kr/downloads/taxlab-bridge.zip)을 풀거나, 아래처럼 검수한 npm tarball을 설치합니다. ZIP은 기존 Claude MCPB와 바이트가 같으며 Node 실행 파일 자체는 포함하지 않습니다.

```sh
npm run build
npm pack --ignore-scripts
bash scripts/install-mcp.sh /absolute/path/k-tax-agent-backend-2.2.0.tgz
```

Windows에서는 `scripts/install-mcp.ps1 -Package C:\Downloads\k-tax-agent-backend-2.2.0.tgz`를 실행합니다. 설치기는 MCP 설정 예시를 출력하며 기존 클라이언트 설정을 덮어쓰지 않습니다. 클라이언트에 `TAXLAB_SERVER_URL=https://law.taxlab.kr`과 기존 key 또는 `TAXLAB_AUTH_TOKEN`을 설정합니다. 설치된 bridge를 `node <bridge-path> --doctor`로 점검할 수 있습니다. 진단은 공개 상태와 인증된 도구 목록만 확인합니다.

## 조회·검증 계약

### 쟁점과 실제 인용을 연결하는 연구 하네스

연결한 AI에게 이렇게 요청할 수 있습니다: **“TaxLab 연구 하네스로 쟁점을 나누고, 실제 원문과 반대 근거를 읽은 뒤, 주장별 인용·빠진 사실을 검사해줘. 다른 쟁점의 자료를 가져다 썼다면 연결 이유와 한계를 밝혀줘.”** 서버용 LLM API나 벡터 DB를 추가로 준비할 필요는 없습니다.

1. `start_legal_research`: 쟁점, 필수 사실, 사건 날짜의 역할·정밀도를 등록합니다.
2. `research_legal_sources`: 기존 법제처·국세청 도구를 읽고 서버가 보관한 `evidence_id`, 정확한 `passage_id/text`를 받습니다. 지지 자료와 반대 자료의 조회 목적을 구분합니다.
3. `review_legal_reasoning`: 최종 초안, 주장별 인용·연결 이유, 반론 처리와 미확인점을 제출합니다. 등록한 필수 사실을 분석에서 빼도 누락 검사를 피할 수 없습니다.
4. `get_legal_research`로 현재 상태를 확인하고 `update_legal_research`로 계획을 바꿀 수 있습니다. 계획 교체는 기존 원문·검토를 무효화하며, 추가 조회도 이전 검토의 현재 효력을 없앱니다.

REST/GPT Actions에는 같은 계약의 POST `/api/research/start`, `/retrieve`, `/review`, `/status`, `/update`가 있습니다. 입력 스키마는 MCP 목록과 [OpenAPI](https://law.taxlab.kr/openapi.json)에 제공됩니다. 기존 `/api/analyze`와 초안 검사도 유지합니다.

`blocked`는 잘못된 인용·연결·모순을 수정해야 한다는 뜻입니다. `needs_info`는 사실·자료·시점·반론 공백이 남았다는 뜻이며 조건부·유보 답변을 표시하지 말라는 뜻은 아닙니다. `structurally_complete`도 **등록한 계획과 제출한 주장만** 구조가 갖춰졌다는 뜻입니다. 법률적 의미와 독립 AI 검수는 여전히 미검수입니다. quote 일치는 제공자가 반환한 텍스트와의 대조이며 원천 XML의 완전성·최신성·법적 지지를 인증하지 않습니다.

연구 장부는 메모리에 30분만 보관하며 재시작 시 사라집니다. 한 연구당 40회 조회, 32개 영수증, 1MiB, 전체 8MiB 보관 예산을 적용합니다. 같은 연구의 조회 중에는 갱신·추가 조회·검토를 잠시 거부합니다. 검색 0건·실패·부분 본문은 성공 근거로 승격하지 않으며, 연구 자료를 로그나 GitHub에 자동 게시하지 않습니다. 공유 접속키는 같은 인증 주체이므로 개인별 자료 격리가 필요하면 사용자 JWT를 사용해야 합니다.

설계 참고: [OpenTax](https://github.com/koi2026/opentax/tree/38c49cba2952dea847ba87970bf2800f1855b763)의 인용·사실·시점 경계와 [korean-tax-agent](https://github.com/minsooparkk/korean-tax-agent/tree/6095cdcf1583a2cd513d08f418b65558346a8845)의 쟁점·반론·공백 구조를 검토했습니다. 새 하네스 TypeScript는 독자 작성했으며 두 프로젝트를 실행 의존성으로 추가하지 않았습니다. [상세 리뷰](docs/HARNESS_REFERENCE_REVIEW.md), [확정 계획·시험 계약](docs/RESEARCH_HARNESS_PLAN.md)을 함께 보세요.

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

시행일은 `Asia/Seoul`의 날짜로 비교합니다. 연혁 일부가 실패해도 성공한 원문과 다른 역할의 결과를 보존하고, 실패한 연혁의 접근 상태를 따로 반환합니다. 일반 조회의 연결+호출 예산은 최대 45초이며, 자식 정리가 끝날 때까지 슬롯을 유지합니다. bridge는 최대 60초의 응답 여유를 두고 전체 SSE 접속은 별도로 15초에 제한합니다. 예상 도구 오류에는 크기 제한과 비밀값 제거를 거친 진단을 남기며, 일반 서버 예외/stack/stderr는 노출하지 않습니다.

MCP `validate_legal_draft` (`validate_tax_draft` 호환 별칭) 또는 `POST /api/validate`:

```json
{"draft_answer":"권리가액과 분담금의 안분을 검토한다.","facts":{}}
```

FC-01~10의 키워드는 필요한 사실을 묻는 데만 사용합니다. 누락은 `needs_info`, 사실을 모두 받더라도 공식 근거를 확정하지 못한 법률 판단은 `unverified`입니다. FC-08~10의 논쟁적인 원가배분 방식을 확정 법리로 넣지 않았습니다. 별도의 `facts.allocation={"total":100,"parts":[40,60]}` 검사는 제출된 수치 합계만 계산합니다.

`assessment_complete`, `scoped_pass`, `coverage`, 초안/사실 hash를 반환합니다. 빈 검사 집합은 `no_coverage`이며 법률 전체의 기존 `passed`는 항상 false입니다. skip/force/warn에는 이유가 필요하고 완료된 실패 결과를 성공으로 바꾸지 않습니다. 답변이 바뀌면 다시 검사해야 합니다. 임의 LLM의 최종 출력을 강제로 통제하는 기능은 없습니다.

## 실패 접수와 Supabase

### 대화 중 법령·해석 정정 PR

사용 중인 AI가 반박·새 공식 근거를 검토해 오류를 인정하면 `prepare_correction_pr`를 호출합니다. 서버가 고정한 공개 미리보기·저장소·질문을 보여주고 사용자 동의를 기다린 뒤 `create_correction_pr`로 실제 draft PR을 만듭니다. 응답을 잃으면 `get_correction_pr`로 같은 제안을 조회합니다. REST/GPT Actions에는 `/api/corrections/prepare`, `/create`, `/status` POST가 같은 계약을 제공합니다. 생성 작업은 GPT Actions에서 consequential로 표시합니다.

동의 hash에는 공개 본문과 대상 저장소가 함께 들어갑니다. 저장소 설정이 바뀌거나 구형 제안에 고정된 대상 정보가 없으면 새 게시를 거부하고 새 미리보기·동의를 요구합니다. 이미 만들어진 구형 PR은 기존 링크와 상태 조회를 유지합니다. 중간 쓰기 후 PR이 없고 남은 branch가 정확한 한 파일 범위임을 확인하면 상태 API가 `retry_available`과 같은 제안의 재시도 인수를 반환합니다. 기존 동의를 바탕으로 한 번 재시도하며 새 제안이나 자동 반복을 만들지 않습니다.

PR에는 기존 오류 요지·정정·공식 출처·재발 방지 점검 항목을 JSON 자료로 담습니다. 생성된 실행 코드는 이 경로에서 받거나 실행하지 않습니다. 작성 AI의 판단은 독립 AI 검수 승인이 아니며 PR에 미확인 상태를 명시합니다. GitHub에서 머지되고 main의 정확한 파일까지 일치한 교정 자료만 `find_legal_corrections` 및 관련 조회 결과에 참고 항목으로 제공합니다. 5분마다 확인하며 마지막 확인 후 10분이 지나면 사용하지 않습니다. 법률 최신성·사건 적용은 계속 미검증 상태입니다.

운영 설정: `CORRECTION_PR_ENABLED=1`, `CORRECTION_STATE_DIR`(권한 제한된 영속 디렉터리), 기존 `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BASE_BRANCH=main`. 토큰은 해당 저장소의 contents/pull requests 쓰기 권한을 사용합니다. 이 경로는 추가 LLM API 키나 Supabase 관리자 키를 요구하지 않습니다. 독립 AI 검수·코드 패치 worker에는 기존 B 조건이 적용됩니다.

PR 기능의 설정·상태 디렉터리 초기화가 실패하면 비밀값 없는 경고를 남기고 해당 기능만 unavailable로 시작합니다. 법령 조회는 계속 가능하며 `/health`의 `correction_pr`로 기능 가용성을 확인합니다. 운영 배포 검증은 이 값이 available인지 별도로 확인해야 합니다.

상태 저장은 단일 서비스 프로세스용입니다. intent를 GitHub 쓰기 전에 저장하고 고정 branch/본문을 대조해 중복 PR을 막습니다. 전체 일일 신규 제안 10건, 보관 1,000건 한도이며 초과 시 성공으로 표시하지 않습니다. 상태 디렉터리는 앱 교체 시 보존해야 하며, 여러 replica가 같은 디렉터리를 공유하는 운영은 지원하지 않습니다. 공유 접속키는 공유 actor입니다. 키·주민번호·기본 식별 패턴 차단은 임의 사건 자료의 완전한 익명화를 보장하지 않으므로 공개 가능한 내용의 미리보기를 반드시 확인합니다.

MCP가 호출되지 않은 대화까지 볼 수는 없습니다. 도구 설명·서버 지침·GPT 지침으로 제안 시점을 알리며, 사용자가 직접 “방금 정정한 내용으로 PR 제안을 준비해줘”라고 요청할 수도 있습니다. 자세한 시험 계약은 [교정 PR 계약](docs/CORRECTION_PR_CONTRACT.md)에 있습니다.

### 기존 실행 코드 개선 접수

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

## 사용한 오픈소스와 크레딧

- [zisu17/korean-taxlaw-mcp](https://github.com/zisu17/korean-taxlaw-mcp): 국세청·지방세 자료 검색과 원문 조회에 사용합니다. [zisu17](https://github.com/zisu17)과 해당 프로젝트 기여자들에게 감사드립니다. 검토한 원본을 별도 MCP 프로세스로 실행하며, 원본 저작권 및 [MIT 라이선스 고지](upstreams/korean-taxlaw-mcp.LICENSE)를 보존합니다. 이 표기는 외부 프로젝트 활용에 대한 크레딧이며 TaxLab에 대한 원작자의 검수·보증을 뜻하지 않습니다.

## upstream 업데이트와 배포

국세청 해석례·불복 결정례의 본문 수집은 별도 zisu17/korean-taxlaw-mcp 제공자를 연결할 수 있습니다. 서버에서 `python3 scripts/install-taxlaw-mcp.py`로 검토한 커밋을 설치하면 기존 인증 REST/MCP에 국세청·지방세 도구 12개가 추가됩니다. 설치·본문 조회·오류 계약·실제 문서 시험은 [국세청 연결 안내](docs/TAXLAW_INTEGRATION.md), OpenTax와 korean-tax-agent를 검토한 후속 구조 제안은 [리서치 하네스 참고 검토](docs/RESEARCH_HARNESS_REFERENCES.md)에 있습니다.

서버에서만 `KOREAN_LAW_MCP_RELEASE_FILE`을 설정하고 최초에 `bash scripts/update-korean-law.sh --bootstrap`으로 별도 설치본을 준비합니다. [cron 예시](deploy/korean-law-update.cron.example)를 설정하면 새 버전은 설치·review·MCP schema 확인을 거친 **후보**로 남습니다. cron은 운영 프로세스를 재시작하거나 후보를 활성화하지 않습니다.

사람이 후보 fingerprint를 포함한 검수 묶음을 승인한 후에만 `bash scripts/update-korean-law.sh --activate <approved-sha256>`를 실행합니다. 활성화 전 설치 파일 전체와 lock을 다시 hash하고 재검증합니다. 실패 시 이전 버전으로 복원하며 복원도 실패하면 journal을 보존하고 운영자의 복구가 필요합니다. 첫 bootstrap과 수동 활성화는 운영자 명령이며 자동 사람 승인 확인 기능을 대체하지 않습니다.

`npm run release:verify -- manifest.json artifact.tgz <approval-comment-id>`는 GitHub에서 운영자의 정확한 manifest 승인, B/H/T, merge 부모/tree, 실제 CI job/step, artifact hash를 읽어 대조합니다. **현재는 읽기 전용 식별 검증이며 배포 허가나 배포 실행기가 아닙니다.** DB 복원·실행 환경·staging/rollback 증거가 없으면 운영 배포 준비 완료로 표시하지 않습니다. PR은 모아 최종 사람이 검수하고 merge합니다.

현재 CI는 [.github/workflows/review.yml](.github/workflows/review.yml)에서 실행됩니다. Ubuntu/Node 22에서 review와 package 시험을 실행하며 production secrets를 전달하지 않습니다. 일반 CI 통과만으로 독립 AI 승인이나 배포 승인을 만들지 않습니다.

## 검증

`npm run review`는 API/auth/session, 실제 stdio와 설치된 upstream 연결, PGlite SQL/RLS/transaction, 후보 활성화/rollback, 근거 상태, 독립 검수 경계 및 merge 검증을 확인합니다. 주입된 model/runner/GitHub port 테스트는 실서비스 AI 실행 증거가 아닙니다.

`npm run review:package`는 실제 npm tarball을 빈 prefix에 설치하고 stdio→SSE→인증 API, doctor, 포함된 rules를 검사합니다. `node scripts/source-smoke.mjs --live`는 설정된 법제처 인증으로 공개 근로기준법과 사건일 연혁을 실제 조회합니다.

법령 조회 A 버전은 GCE에서 공개 HTTPS로 운영하며, 기존 직접 공개 포트는 닫았습니다. 교정 자료 PR과 별개로 남은 검증 범위는 실제 Supabase 코드 개선 접수 migration/복원, 격리된 AI/patch executor, 독립 AI 검수 및 사람 승인 후 artifact 활성화/rollback 전체 흐름입니다.
