# Legal Harness: Express → korean-law-mcp

Express가 공식 `korean-law-mcp` 배포 패키지를 **별도 stdio 자식 프로세스**로 실행하고 MCP Client SDK로 통신한다. 원작자의 파싱·조회 코드는 복사하거나 수정하지 않는다. 기본 설치 버전은 `package-lock.json`으로 고정하며, 서버 배포 시 함께 구성할 cron이 관리하는 별도 설치 경로도 지정할 수 있다.

```text
호출자 / LLM → Express HTTP API → MCP Client → stdio → korean-law-mcp → 법제처
                         └→ Supabase Auth / 사용자별 DB 접근
```

이번 구현은 Express의 **상위 MCP 서버 호출**과 DB 스키마다. Express 자체를 MCP 클라이언트에 등록할 수 있는 표준 MCP 서버 전송 계층은 아직 별도 구현이 필요하다. 일반 조회에 서버 측 LLM API 키는 필요하지 않다.

## 설치와 실행

Node.js 22 이상을 사용한다. 프로젝트 루트에서 실행한다.

서버에는 `.ts` 파일만이 아니라 프로젝트 폴더 전체를 옮긴다. `node_modules/`, `dist/`, `.runtime/`, 실제 `.env`는 제외한다. `src/`, `tests/`, `scripts/`, `deploy/`, `supabase/`, `package.json`, `package-lock.json`, `tsconfig.json`, YAML 파일, `.npmrc`, `ecosystem.config.cjs`는 함께 필요하다. 서버에서 의존성을 설치·빌드하고 `.env`를 새로 설정한다.

upstream의 TS 원본은 따로 복사하지 않는다. 공식 npm 패키지에 포함된 빌드 결과를 별도 프로세스로 실행한다.

```sh
npm ci
```

`.env.example`을 `.env`로 복사한 뒤 다음 값을 설정한다.

- `SUPABASE_URL`과 `SUPABASE_PUBLISHABLE_KEY` 또는 기존 `SUPABASE_ANON_KEY`
- 법제처에서 발급한 `LAW_OC` 인증키

`SUPABASE_ANON_KEY` 자리에 service-role/secret 키를 넣지 않는다. `/api/analyze`, `/api/tools`, `/api/evolve` 호출 시에는 Supabase Auth 로그인으로 얻은 사용자 access token을 `Authorization: Bearer <token>`으로 전달한다.

```sh
npm run review
npm start
```

`review`는 TypeScript를 빌드하고 기존 회귀 테스트, 실제 stdio 통신, 설치된 공식 패키지의 연결, 로컬 PostgreSQL의 SQL/RLS 테스트를 실행한다. 법제처 호출·GitHub PR 생성·실제 Supabase 변경은 하지 않는다. `.npmrc`는 선택적 OCR/ML·네이티브 의존성과 설치 스크립트를 제외한다. 선택적 기능이 필요한 경우 해당 의존성과 서버 자원을 별도로 구성해야 한다.

## 조회 API

`GET /api/tools`는 실행 중인 MCP 서버의 이름·버전과 도구별 입력 JSON Schema를 반환한다. 도구 구현과 스키마의 소유자는 upstream이다.

`POST /api/analyze` 기본 요청:

```json
{ "query": "과세처분 불복 절차" }
```

기본 도구는 자연어 질문을 받는 `legal_research`다. 단순 법령 검색에는 호출량을 줄일 수 있는 `search_law`를 직접 선택한다.

```json
{ "query": "소득세법", "tool": "search_law", "arguments": { "display": 5 } }
```

검색 결과의 식별자로 특정 조문을 조회한다. 아래 식별자는 실제 검색 결과로 교체한다.

```json
{
  "query": "소득세법 제88조 원문",
  "tool": "get_law_text",
  "arguments": { "mst": "검색에서 받은 법령일련번호", "jo": "제88조" }
}
```

`tool`은 `/api/tools`에서 확인한 이름이어야 한다. `arguments`는 해당 upstream 스키마에 맞춘다. `legal_research`, `search_law`, `search_decisions`의 `arguments.query`는 최상위 `query`로 설정된다. 그 밖의 도구에는 `arguments`를 그대로 전달한다. 실행 파일·환경변수 등 프로세스 설정은 HTTP 요청으로 받지 않는다.

응답의 `data.result`에 upstream의 `content`, `structuredContent`, 출처 링크, `_meta`를 보존한다. `data.kind`는 `retrieval`이고 `data.retrieved_at`은 이번 **조회 완료 시각**이다. 이를 법령의 현행성·예규의 적용 가능성 확인 시각으로 해석하면 안 된다. upstream이 제공한 시행일·식별자와 사건 기준일을 호출자가 대조해야 한다. 서버가 답변을 생성하는 기존 mock은 제거했다.

`draft_answer`를 함께 보내면 해당 초안을 기존 YAML 게이트로 검사한다. 생략하면 기존 호환 동작대로 `query`를 검사한다. `quality_gate.passed`는 그 텍스트에 대한 기존 규칙 검사 결과이며, 조회 자료나 최종 법률 판단 전체를 검증했다는 뜻이 아니다.

| 오류 | HTTP 상태 |
| --- | --- |
| 요청 형식·도구 이름·도구 인자 오류 | 400 |
| 인증 실패 | 401 |
| 동시 처리 한도 초과 | 429 |
| upstream 도구 오류 또는 연결 끊김 | 502 |
| 인증키 미설정·프로세스 시작/초기화 실패 | 503 |
| 도구 호출 시간 초과 | 504 |

MCP의 `isError: true` 응답은 성공으로 바꾸지 않는다. 일부 upstream 도구는 부분 성공·조회 불가 사유를 본문에 표시할 수 있으므로 HTTP 성공만으로 근거 확보 완료를 판단하지 않는다.

## 서버 배포 시 MCP 업데이트 cron 구성

서버를 배포할 때 **MCP 자동 업데이트 스크립트와 cron을 함께 구성한다.** Express와 MCP 설치본, 업데이트 작업은 같은 서버에 둔다. 배포용 파일은 구현되어 있으며, 실제 Linux 서버에 cron을 등록하는 단계는 아직 수행하지 않았다.

- [scripts/update-korean-law.sh](scripts/update-korean-law.sh): Linux 진입점. `flock`으로 중복 실행을 막는다.
- [scripts/mcp-update.mjs](scripts/mcp-update.mjs): 공식 최신 버전 조회, npm 설치, 회귀 검사, MCP 연결 검사, PM2 재시작 및 상태 확인.
- [scripts/lib/mcp-update.mjs](scripts/lib/mcp-update.mjs): 버전 전환, 이전 버전 복구, 중단된 작업 복구 및 설치본 정리.
- [cron 예시](deploy/korean-law-update.cron.example): 하루 한 번 실행할 `/etc/cron.d` 설정.
- [로그 회전 예시](deploy/korean-law-update.logrotate.example): 업데이트 로그 보관량 제한.

서버 `.env`에 다음 값을 설정한다. 수동 `KOREAN_LAW_MCP_COMMAND`, `KOREAN_LAW_MCP_ARGS`, `KOREAN_LAW_MCP_CWD`와 함께 사용하지 않는다.

```dotenv
KOREAN_LAW_MCP_RELEASE_FILE=/opt/legal_harness/.runtime/korean-law/active.json
KOREAN_LAW_UPDATE_HEALTH_URL=http://127.0.0.1:3000/health
```

최초 배포는 **PM2를 실행할 서비스 계정으로** 프로젝트 루트에서 진행한다. Node/npm이 cron의 `PATH`에서도 검색 가능해야 하며 Linux `flock`(util-linux)이 필요하다. `review`와 PM2를 사용하므로 이 프로젝트는 devDependencies도 설치한다.

```sh
npm ci
npm run build
bash scripts/update-korean-law.sh --bootstrap
npm run deploy
npm run smoke:mcp
```

`--bootstrap`은 새 설치본을 검증하고 `active.json`을 만들며, 아직 시작하지 않은 Express를 재시작하지 않는다. 이후 cron 예시의 서비스 계정·경로·PATH·서버 시간대를 실제 배포 환경에 맞춘 뒤 `/etc/cron.d/legal-harness-mcp`에 설치한다. 로그 회전 예시는 `/etc/logrotate.d/legal-harness-mcp`에 설치한다. 예시는 **UTC 서버의 18:30 = 한국 시각 다음 날 03:30** 기준이다. 관리자 권한으로 설치하는 설정 파일은 root 소유, 0644 권한으로 둔다. 업데이트 작업은 PM2와 같은 서비스 계정으로 실행한다.

수동 갱신 확인도 잠금 진입점으로 실행한다.

```sh
bash scripts/update-korean-law.sh
```

갱신 작업은 다음 순서로 동작한다.

1. 공식 npm `latest`와 운영 버전을 비교한다. 같은 버전이거나 더 오래된 버전이면 설치·재시작 없이 끝낸다. 자동 적용 대상은 `숫자.숫자.숫자` 형식의 정식 배포 버전이다.
2. 새 버전은 `releases/` 아래 별도 디렉터리에 설치한다. 기존 설치본은 덮어쓰지 않는다. 설치 스크립트와 선택적 OCR/ML 의존성은 실행·설치하지 않는다.
3. `npm run review`와 **새 설치본**의 실제 MCP 초기화·버전·필수 도구 스키마 검사를 통과시킨다. 자동 작업은 법제처 API를 호출하지 않는다.
4. 복구 기록을 남기고 `active.json`을 원자적으로 교체한다. PM2로 Express를 재시작한다. `/health`의 `mcp_release`가 새 버전인지 확인하고 활성 MCP 실행 파일의 연결도 다시 검사한다.
5. 실패하면 이전 실행 파일로 되돌리고 재시작·상태 확인을 수행한다. 복구까지 실패하거나 작업이 중간에 종료되면 `pending.json`을 남겨 다음 실행에서 복구를 재시도한다.
6. 정상 적용 후 현재 버전과 직전 버전만 보관한다. 실패한 설치본은 제거한다. 로그는 cron 출력 파일과 logrotate 설정으로 관리한다.

이미 실행 중인 MCP는 이전 코드를 계속 사용하므로 재시작이 필요하다. `kill_timeout: 15000`은 Express가 HTTP 요청과 자식 프로세스를 정리할 시간을 준다. 전환 전 검사 실패 시 서비스는 기존 버전을 유지한다. 자동 업데이트는 upstream 배포 버전 갱신이며, 우리의 실패 패치를 AI·사람이 검수하는 절차와는 별도다.

`active.json`은 실행 파일 선택 정보다. 법령 자료의 최신성을 나타내지 않는다. `/health.mcp_release` 역시 Express가 읽은 설정 버전이며, 법령 원천 조회 성공을 보증하지 않는다.

cron을 사용하지 않는 로컬 환경에서는 기존 패키지 설치 또는 `.env.example`의 수동 실행 경로 설정을 계속 사용할 수 있다.

## 프로세스와 자원

- Express 프로세스마다 MCP 자식 하나를 필요할 때 시작하고 재사용한다. 여러 요청의 초기화도 하나로 합친다.
- HTTP 작업 및 MCP 도구 작업은 각각 최대 3개다. HTTP 연결이 먼저 끊겨도 MCP 작업은 완료/시간 초과까지 자체 슬롯을 유지한다.
- 초기화 기본 10초, 도구 호출 기본 45초다. 시간 초과 시 프로세스를 정리하고 **다음 요청**에서 새로 연결한다. 진행 중이던 다른 요청도 실패할 수 있으며 자동 재실행하지 않는다.
- 자식에게는 SDK의 기본 OS 환경과 법제처 관련 설정만 넘긴다. Express의 Supabase/GitHub 키, `NODE_OPTIONS`는 전달하지 않는다. 같은 OS 계정의 프로세스 분리이며 보안 샌드박스는 아니다.
- 추가 MCP 수신 포트는 필요 없다. 서버에서 법제처로 나가는 네트워크 연결은 필요하다. PM2 `instances: 1`을 늘리면 MCP 개수·동시 호출량도 증가한다.
- PM2의 `max_memory_restart`는 Express 메모리 기준이다. MCP 자식과 OS의 메모리까지 포함한 VM 전체 사용량은 별도로 확인해야 한다.
- MCP 프로그램 업데이트와 법령·예규의 최신성 확인은 별개다. 버전 추적·사건 시점 대조·후속 해석 확인은 아키텍처 명세의 후속 구현 범위다.

## Supabase 스키마

[`supabase/migrations/202609140001_profiles_evolution_logs.sql`](supabase/migrations/202609140001_profiles_evolution_logs.sql)을 Supabase SQL Editor에서 한 번 실행하거나 Supabase CLI migration으로 적용한다. 해당 public 테이블이 아직 없는 프로젝트용 초기 마이그레이션이다. 기존 동명 테이블이 있으면 스키마 차이를 먼저 맞춰야 한다. 전체 DDL은 트랜잭션으로 실행된다.

- `auth.users`: Supabase Auth가 관리한다. 직접 생성하거나 비밀번호 테이블을 만들지 않는다.
- `profiles`: 신규 가입 트리거와 기존 사용자 backfill을 제공한다. 사용자는 자기 프로필 조회·표시 이름 수정만 가능하다.
- `evolution_logs`: `/api/evolve`의 제출자, 문제, 규칙, 교정 문구, PR URL, 검토 상태를 저장한다. 사용자는 자기 기록 조회와 `pending_human_review` 제출만 가능하다.
- 최종 승인/거절/병합 및 검토자 필드는 신뢰된 검토 처리 계정으로 갱신한다. 일반 사용자 JWT에는 수정·삭제 권한이 없다.

현재 `supremeJudge.ts`의 AI 검수와 `gitOps.ts`의 PR 생성은 여전히 mock이다. 이 SQL의 pending 기록이나 현재 `/api/evolve` 성공 응답을 실제 AI 검수·PR 생성의 증거로 사용하면 안 된다. 이번 작업은 이 두 단계의 실제 구현까지 포함하지 않는다.

## 검증 범위

`npm run review`에서 42개 테스트 통과: 기존 9개, API 연동·버전 표시 6개, 실제 stdio·배포 버전 설정 11개, 업데이트·복구 10개, PostgreSQL 검증 6개(상위 테스트 포함). PostgreSQL 테스트는 PGlite에서 Supabase 역할·`auth.uid()`를 구성해 실행한다. 업데이트 상태 전환 테스트는 설치·PM2·HTTP 작업을 대체해 실행하며, 실제 서버에서 cron·PM2를 구동한 결과를 대신하지 않는다. 실제 stdio 연결은 설치된 공식 패키지로 별도 검증한다.

```sh
npm run smoke:mcp
# LAW_OC 설정 후 실제 법제처 검색을 1회 요청하려면:
npm run smoke:mcp -- --live
```

기본 smoke는 도구 목록만 확인하고 법제처 API를 호출하지 않는다. `--live`는 `search_law` 도구를 한 번 호출한다. 해당 도구 내부에서 여러 법제처 API 요청이 발생할 수 있다.

참고: [korean-law-mcp 공식 배포 안내](https://github.com/chrisryugj/korean-law-mcp), [MCP SDK v1 문서](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x), [Supabase 사용자 데이터](https://supabase.com/docs/guides/auth/managing-user-data), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
