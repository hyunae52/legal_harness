# 연결 안내 확인 기록

2026-09-21, 현재 TaxLab: HTTPS SSE(`/sse`), `Authorization: Bearer` 또는 `x-api-key`. Streamable HTTP와 OAuth는 미구현이다. 제품 전체의 MCP 지원과 이 서버의 인증·전송 방식 호환을 구분한다.

| 클라이언트 | 공식 근거와 현재 안내 |
|---|---|
| Claude 웹 | [Remote MCP](https://claude.com/docs/connectors/custom/remote-mcp)의 Request headers는 일부 조직 대상 베타. 메뉴가 있으면 No sign-in + x-api-key + SSE로 구성 가능. 없으면 현재 직접 연결 불가. [인증 문서](https://claude.com/docs/connectors/building/authentication)도 static_headers 베타를 명시한다. |
| ChatGPT 데스크톱 | [공식 MCP 문서](https://learn.chatgpt.com/docs/extend/mcp)는 MCP servers 설정, STDIO/Streamable HTTP 및 공유 config.toml을 설명한다. TaxLab은 검증된 STDIO bridge를 제공한다. 메뉴가 없는 앱은 이 경로를 사용할 수 없다. 웹 Actions의 PC 앱 호환을 추정하지 않는다. |
| ChatGPT 웹 | [GPT Actions](https://developers.openai.com/api/docs/actions/getting-started)와 [API Key 인증](https://developers.openai.com/api/docs/actions/authentication) 경로. [원격 플러그인 안내](https://developers.openai.com/plugins/deploy/connect-chatgpt)의 Streamable HTTP 연결에 현재 SSE 주소만 넣을 수는 없다. |
| Gemini CLI | [MCP 문서](https://geminicli.com/docs/tools/mcp-server/)의 `url`은 SSE, `httpUrl`은 Streamable HTTP. [설정 문서](https://geminicli.com/docs/reference/configuration/)는 settings.json 문자열의 환경변수 확장을 명시한다. headers에 TAXLAB_API_KEY를 참조한다. |
| Gemini 웹·모바일 | [Google 조건](https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&hl=en-GA): 미국, 18세 이상, 개인 계정, 영어, Keep Activity 켜기. 국내 일반 사용자의 연결 방법으로 안내하지 않는다. 조건 해당 계정의 TaxLab 인증 호환도 미검증이다. |
| Antigravity | [공식 MCP 문서](https://antigravity.google/docs/mcp): `serverUrl`은 원격 SSE/HTTP, `headers` 지원. CLI는 `url`/`httpUrl`을 사용하지 않는다. [Google 설정 예시](https://developers.google.com/knowledge/mcp)와 앱/IDE/CLI의 설정 위치도 대조했다. |

Claude PC 설치파일의 내용·격리 실행 및 로컬 bridge의 인증 SSE 통신은 기존 실행 시험으로 확인했다. 같은 ZIP을 ChatGPT용 로컬 연결 파일로 제공하며 별도 런타임은 포함하지 않는다. 공식 지원 조건, 설정 파일 검사, 실제 앱 UI에서의 설치·도구 호출은 서로 다른 증거다. Claude 웹/PC UI, GPT 편집기/데스크톱 UI, Antigravity 앱 UI를 시험한 것으로 보고하지 않는다.

이 변경은 안내·정적 다운로드에 한정한다. 운영 인증을 해제하거나 URL 접속키·무인증 우회를 추가하지 않는다.

Gemini CLI 0.60.0 실제 확인: 별도 임시 설정 디렉터리에서 공개 설정 그대로 `gemini mcp list`를 실행했다. 기존 `url` 단독 설정은 `Disconnected`; `type: "sse"`를 추가한 뒤 운영 HTTPS endpoint에 `Connected`였다. 설치된 공식 CLI의 초기 연결·ping 검사 결과이며 LLM·법령 도구 호출은 0이다. 사용자 기존 Gemini 설정은 변경하지 않았다. 문서의 `url` 설명만으로 최신 버전의 기본 transport를 추정하면 안 된다.

Antigravity 확인: 설치된 `agy mcp add --help`에서 `--header`를 이름 앞에 두는 등록 형식을 확인했다. 이 설치본의 `agy mcp list`는 별도 작업 폴더의 `.agents/mcp_config.json`을 인식하지 않았다. 따라서 CLI 안내는 경로를 단정하지 않고 `agy mcp add` 등록 명령을 사용한다. 공개 Antigravity 설정의 endpoint·headers를 MCP SDK로 연결하여 도구 18개를 확인했다. 이것은 Antigravity 자체의 도구 호출 증거가 아니며 실제 앱 UI는 미검증으로 표시한다.
