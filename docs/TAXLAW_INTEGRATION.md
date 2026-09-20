# 국세청·지방세 자료 제공자 연결

법령·조문·연혁은 기존 korean-law-mcp가 맡고, 해석례 본문은 zisu17/korean-taxlaw-mcp를 별도 stdio 자식 프로세스로 실행해 읽는다. 사용자에게 보이는 접속 URL과 인증 방식은 같다. Python 3.11 이상은 서버에만 필요하다.

## 설치와 검증

```sh
# Linux 서버: Python 3.11+와 venv 지원이 필요하다.
python3 scripts/install-taxlaw-mcp.py
npm run build
node scripts/taxlaw-smoke.mjs --live
```

Windows에서는 `python scripts/install-taxlaw-mcp.py` 또는 `npm run taxlaw:install`을 사용한다. 설치는 공개 저장소의 고정 커밋 ZIP을 SHA256으로 확인하고 전용 venv에 패키지를 설치한다. Supabase·GitHub·법제처 키를 Python 자식에게 전달하지 않는다. NTS 조회에 별도 API 키나 유료 스크래핑 API는 사용하지 않는다.

기본 선택 파일은 `.runtime/taxlaw/active.json`이다. 다른 경로로 설치하려면 `--directory /absolute/path`를 주고 `TAXLAW_MCP_RELEASE_FILE=/absolute/path/active.json`을 설정한다. 서비스 계정이 설치 디렉터리를 읽고 Python을 실행할 수 있어야 한다. 앱이 시작할 때 선택 파일을 읽으며 설치 스크립트가 서비스를 재시작하거나 배포하지 않는다.

코드·버전 핀: [upstreams/korean-taxlaw-mcp.json](../upstreams/korean-taxlaw-mcp.json). 도구 스키마는 해당 커밋의 실제 MCP tools/list에서 얻었다. 원본 MIT 고지는 `upstreams/korean-taxlaw-mcp.LICENSE`에 보존했다. 설치된 의존성 버전은 release 디렉터리의 `installed-dependencies.txt`에 저장한다. pip의 선언 버전 범위를 설치하므로 모든 전이 의존성을 잠근 재현 빌드는 아니다.

업데이트할 때는 커밋·아카이브 해시·버전·도구 스키마를 같은 PR에서 변경하고 회귀 및 라이브 시험을 다시 실행한다. 기존 korean-law-mcp cron이 이 Python 제공자까지 자동 갱신하지는 않는다.

## 호출

문서번호가 있으면 MCP `lookup_tax_document`:

```json
{"document_number":"서면-2020-부동산-4503","detail":"full","include_full_text":true}
```

검색이 필요하면 `search_tax_interpretations` 또는 `search_tax_decisions`로 후보를 찾은 뒤, 반환된 `ntstDcmId`를 `get_tax_document`에 전달한다. 본문은 facts, question, answer, reasoning, conclusion 등 문서에 존재하는 필드로 반환한다. 요약 목록만으로 사안에 적용할 결론을 확정하면 안 된다.

REST `/api/analyze`에도 같은 도구가 연결된다:

```json
{"tool":"lookup_tax_document","query":"공유물 분할 원문 확인","arguments":{"document_number":"서면-2020-부동산-4503"}}
```

선택 제공자가 설치되면 총 12개의 upstream 도구를 추가로 제공한다. `/api/tools`와 MCP `tools/list`에서 실제 제공 목록을 확인한다. 설치 전에는 기존 법령 도구만 제공하고 NTS 도구를 직접 호출하면 `TAXLAW_NOT_CONFIGURED`를 반환한다. `/health.taxlaw_release`는 **설정된 릴리스**이며 국세청의 실시간 가용성 확인 결과는 아니다.

`get_decision_text(domain=nts)`의 호환 경로는 18자리 국세청 ID일 때만 새 제공자로 연결한다. 법제처 검색 일련번호(예: 212174)를 넣으면 `NTS_ID_REQUIRED`와 문서번호 조회 안내를 반환한다. ID를 추측하거나 다른 문서로 대체하지 않는다.

## 오류와 검증 범위

- upstream은 `[NOT_FOUND]` 같은 문자열을 MCP 성공 응답 안에 넣기도 한다. 어댑터는 이를 실제 오류로 변환한다. 검색 0건, 본문 미제공, 원천 장애, 파싱 실패를 구분한다.
- 전용 자식은 동시 2건, 앱 전체는 기존 동시 3건 한도를 공유한다. 총 요청 시간 초과 시 해당 자식을 종료한 뒤 다음 요청에서 다시 시작한다. 실패한 호출을 자동 재전송하지 않는다.
- 조회 근거에는 실제 제공자의 이름·버전을 기록한다. zisu 응답에 기존 법제처 제공자의 버전을 잘못 붙이지 않는다.
- 라이브 시험은 로컬 Express의 인증 REST와 SSE를 실제 Python 프로세스에 연결한다. 해석례 3건·불복 결정례 2건, 동일 문서 표기 변형, NTS ID 조회, 잘림 안내, 부분 번호 거부, 잘못된 ID를 점검한다. 결과는 `.runtime/taxlaw/live-integration.json`에 기록된다.
- 절 분류는 upstream의 규칙 기반 추출이다. 실제 `조심-2025-인-4460`에서는 결론 뒤 `<별지> 관련 법령`이 conclusion 필드에 함께 들어왔다. 본문은 보존됐지만 필드명이 항상 순수한 의미 구간을 뜻하지는 않는다. `detail=full`로 관련 절을 함께 읽고, 결론 필드의 모든 문장을 재결의 판단이라고 취급하지 않는다.
- 국세청 본문 조회 성공은 문서의 현재 효력·후속 해석·사건 적용·법률 결론의 검증 완료가 아니다. 이 상태는 기존 evidence에서 계속 `unverified`로 남는다.
