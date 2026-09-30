# korean-law-mcp 4.15.1 적용

법령 제공자는 공식 npm `korean-law-mcp@4.15.1`을 사용한다. 원본 소스를 복사하거나 수정하지 않고 기존 stdio 연결을 유지한다. `package.json`, `npm-shrinkwrap.json`, `package-lock.json`을 함께 갱신했다. 별표 파서는 원작자의 이 릴리즈에서 사용한 `kordoc@4.17.0`으로 잠갔고, 다른 패키지 버전은 유지했다. 세법 제공자는 검증된 포크 `2.1.0.post1`을 계속 사용한다.

[원본 릴리즈](https://github.com/chrisryugj/korean-law-mcp/releases/tag/v4.15.1)의 변경은 HWP 별표의 보이지 않는 틀 표를 문단으로 풀고, 보이는 표·분수·위아래첨자를 보존하는 것이다. `get_law_text.efYd`의 안내도 사건 기준일을 받아 당시 시행 버전으로 보정하는 실제 동작에 맞춰 수정됐다. 도구 이름과 인자는 같다.

## 검증

- `npm run review`, `npm run review:package`, `npm run audit:runtime`, `npm run security:secrets`.
- `node scripts/law-release-smoke.mjs --live`: 국세기본법의 사건일 조문, 개명한 소방 법령의 연혁, 도로교통법 시행규칙 별표, 과거 시점 별표에 더해 대기환경보전법 시행령 별표 8의 분리된 표 5개와 할부거래에 관한 법률 시행령 별표 1의 분수식을 확인한다. 공개 법제처 자료를 실제 조회하므로 원문 변경이나 외부 장애는 별도로 판별해야 한다.
- GCE의 별도 후보 설치에서 운영과 같은 Node 22, 잠금 파일, 동시 조회 3건으로 검증하고 메모리 사용량을 기록한다. 운영 전환 후 공개 MCP 연결에서도 실제 조회를 확인한다.

## 배포와 추적

법령 엔진 변경은 보호된 배포 항목이다. 별도 후보를 검증한 후 기존 배포 게이트의 접속 차단·요청 종료 대기·전환·검증·실패 시 복구 순서로 release manifest와 배포기 기준을 갱신한다. 기존 설치본을 복구용으로 보존한다. 다운로드 한도 8 MiB/전체 24 MiB, 동시 작업 3건은 유지한다.

이후 main 병합으로 앱 패키지를 자동 배포한다. `/health`의 `mcp_release`는 법령 엔진 버전, `release_commit`은 앱 커밋이다. 적용 직후 일일 업데이트 확인기를 알림 발송 없이 실행해 설치 버전 인식을 검증한다. 매일 한국시간 03:30의 확인 일정은 그대로다.
