# 연구 하네스 GCE 배포 기록

2026-09-21 KST. 운영 주소: https://law.taxlab.kr . 기존 사용자 지시에 따른 배포이며 PR #9는 검토용 draft로 남겨 두었다. 자동 merge는 하지 않았다.

## 고정 대상

- 앱 릴리스: `75314179eb1d2fbf17ad5eb2ad367031d99749dc`. [Linux CI](https://github.com/hyunae52/legal_harness/actions/runs/35534024679) 성공.
- 배포 호출기: `b84fe1327e0fc7d4f550a3cf6d9f142b201808ea`. [Linux CI](https://github.com/hyunae52/legal_harness/actions/runs/35534642267) 성공. 마지막 차이는 설치가 완료된 후보의 실패한 smoke를 파일 지문 재검증 후 다시 확인하는 restage 절차다. 앱 TypeScript·패키지·원문 제공자는 변경하지 않았다.
- tarball SHA-256: `d63b301deaeea5d48c9719da7918b23cb3cff6216abae4a83d8de603f9464ce6`, 파일 47개를 각각 검증했다.
- 설치 Node 의존성 지문: `bd4653a5c3b1b77dc5624dd5cfc3bbb2d1bab44b61b650b5ae8a6feb2e95746c`, 파일 6,679개·symlink 9개. 기존 앱과 실제 별도 법제처 실행 경로도 이 지문과 일치했다.
- NTS: zisu17/korean-taxlaw-mcp `d77c94e5b64892fe85928508544366e418397c71`, 2.0.0, archive hash 검증 후 전용 venv 설치. Python 3.13.5, FastMCP 3.4.7, MCP 1.30.0, httpx 0.28.1. 전체 freeze SHA `246f788d6ca347801bd3286d5fcb4deb9d0310ef5956466a3b42b9cdbddec538`.
- 기존 `a9808ddd629f18cb915e710bf52835fe6db400e5` 및 artifact SHA `c0977a5e3508d02c1340cde15307b05ba8c10413c14fb182f96809b584df1561`는 복귀용으로 보존했다. 교정 영속 기록을 복사본으로 덮어쓰지 않았다.

[구조화된 실행 증거](evidence/research-harness-deployment-20260921.json)에 stage·drain·전환·HTTPS 결과 및 설치 지문을 기록했다. 키와 개인 사건 자료는 포함하지 않는다. 이 기록은 Codex의 실제 실행 결과이며 Pro가 GCE 명령을 직접 실행했다는 뜻이 아니다.

## 설치 중 발견한 문제와 처리

Debian에 venv 모듈은 있었지만 ensurepip 구성요소가 없어 설치가 한 차례 실패했다. 공식 APT의 python3.13-venv, python3-pip-whl, python3-setuptools-whl 세 패키지만 추가했다. 기존 패키지 upgrade 0/remove 0이다.

기존 설정은 조회용 candidate.env와 교정용 corrections.env로 나뉘어 있었다. 후보 smoke가 처음에 교정용 파일만 읽던 오류를 수정했다. 기존 배포 manifest에 기록된 조회 환경파일·upstream manifest hash를 확인하고, 필요한 법제처 설정만 allowlist로 전달한다. 후보 앱에는 교정 게시자를 구성하지 않으며 GitHub 키와 운영 교정 디렉터리를 넘기지 않는다.

설치 직후 법제처 MCP 초기화 timeout도 관측했다. 원천을 성공으로 꾸미거나 한도를 늘리지 않았다. 독립 stdio probe에서는 4.13.0 초기화(1.8초)와 도구 10개를 확인했고, 종료가 확인된 실패 후보에 한해 같은 파일 지문·Python pin·기존 서비스 상태를 재검증한 restage가 통과했다. timeout의 하위 원인을 캐시나 CPU로 단정하지 않는다. 운영 전환 후 새 프로세스와 공개 HTTPS에서 별도 실조회가 통과했다.

## 실제 전환

1. 후보는 별도 loopback 포트에서 REST/MCP SSE 원문 조회와 검토를 통과했다. 시험 process tree 최대 RSS 278.2MiB, 호스트 MemAvailable 최소 271.4MiB, wall 10.0초였다. 전체 서비스의 상시 메모리 보장이나 지속 부하 시험으로 확대하지 않는다.
2. Cloudflare 프로세스 실제 UID=root와 기존 설정 사용을 확인했다. 이 서비스의 root→127.0.0.1:3100 연결만 차단하고 기존 연결을 정리했다. root probe는 거부되고 cta 운영 probe는 계속 성공했다.
3. 기존 artifact의 인증 코드와 실제 Node가 선택하는 Supabase CJS SDK 파일 hash를 확인했다. 단일 JWT getUser fetch의 5초 AbortSignal 경로를 확인하고, 연결 정리 이후 6.103초 경과 및 event-loop 응답·active_requests=0, 동일 이전 PID를 확인한 뒤 전환했다. 단순 active=0 한 번만으로 정지 상태를 선언하지 않았다.
4. 90-research.conf만 추가해 새 릴리스로 전환했다. 이전 70-client-guide override는 보존했다. 신규 앱의 drain을 위해 TimeoutStopSec=90을 적용했다. 인증 완료 후 재확인·진행 중 게시 종료 대기는 코드 시험에 포함돼 있다.
5. 공개 차단 상태에서 새 릴리스 commit·파일·의존성·health 및 실제 REST/MCP 원문 검사를 통과한 뒤 작업 소유 규칙을 제거했다. 결과는 candidate_active_verified/public_resumed=true였다. 공개 재개 전후 불명확한 결과는 자동 교체하지 않는 별도 오류 경계가 있다.

공개 재개 시각: 2026-09-20T20:14:03.807Z (KST 05:14:03). 이 전환에서는 rollback을 실행하지 않았다. 실패·rollback·응답 유실 경로는 모형 시험이며 실전 장애 주입이라고 주장하지 않는다.

## 공개 검증

2026-09-20T20:14:32.757Z에 https://law.taxlab.kr 를 통과한 REST+MCP SSE 실제 요청이 성공했다.

- MCP 도구 35개, 신규 연구 도구 5개.
- `서면-2020-부동산-4503`: 본문 4개 passage, response hash `5c94093c787ba6a917f6c0c54b44d661a1b8c71d4a3b024525dbfdcbad42e1f6`.
- 정확한 인용 quote_match=true, 미확인 사실 needs_info, 위조 인용 blocked, 법률 검수 unverified. GitHub 쓰기 0.
- 외부 Windows의 Node fetch에서도 `/`, `/health`, `/setup.md`, `/openapi.json` 모두 200이며 연구 경로 5개를 확인했다.
- 운영 검증 직후 서비스 cgroup 메모리 약 203.4MiB / 제한 640MiB, 호스트 MemAvailable 약 290MiB. 단일 문서 검증 수치이며 다수 동시 사용자 용량 시험은 아니다.

기존 Cloudflare 정책에서 기본 Python-urllib User-Agent는 1010/403을 받았다. 동일 경로에서 Node, python-httpx/0.28.1, 브라우저 User-Agent는 200이었다. 이번에 Cloudflare 정책을 변경하지 않았고, 기본 urllib도 무조건 지원한다고 설명하지 않는다.

## 검수 상태

**REVIEW PASS / PLAN PASS / CODE PASS / DEPLOYMENT PASS.** CODE 고정 대상은 `5f5ee328cdce448c6854ef2b99edffee3d96b203`이며 CR-01~03 및 원격 완료 불명 보호를 확인했다. 전체 130개·설치 패키지 7개 통과. 최초 DEPLOYMENT 검수는 원본 결합 자료 누락 DR-01로 REVISE였고, 아래 자료를 보완한 고정 증거 `196b1a95b98fc5083ab3d80431877c0b50a795cf`에 대해 Pro가 **DR-01 CLOSED / DEPLOYMENT PASS**를 판정했다. 남은 필수 보완·재배포 요구는 없다.

판정은 앱 `75314179…`, 배포 artifact `d63b301d…9464ce6`, helper `b84fe132…` 및 해당 고정 증거에 적용된다. Pro는 공개 코드·CI 로그·파일별 hash 목록·commit/tree·실행 기록의 일관성을 확인했고, 실제 빌드·GCE·HTTPS MCP 실행은 Codex가 수행했다. [단계별 Pro 대화](https://chatgpt.com/c/6ab023ff-1d48-83ee-b465-31894bedbd22). 이후 문서 상태 정리는 운영 릴리스를 변경하지 않는다.

## DR-01: 실제 배포 파일과 고정 소스의 대응

[실제 설치 결합 기록](evidence/research-harness-installation-binding-20260921.json)은 helper가 사용한 release packet 전체를 포함한다. `head`, `tree`, tarball hash, 47개 경로별 hash, `operator_files`, helper hash, CI 참조가 원본 입력과 일치한다. 기존 설치 보고의 Python 선택 파일·전체 freeze 69개 항목과 hash도 포함했다. 환경파일은 역할·경로·hash만 공개한다.

배포 이후 읽기 전용 점검에서 운영 tarball과 설치된 47개 파일·보조 파일을 packet과 다시 대조했다. 실제 새 앱·보존한 이전 앱·별도 법제처 프로세스가 쓰는 세 `node_modules` 경로의 전체 지문은 모두 기록된 `bd4653a5…95746c`였다. 실행 중인 Node PID 81286과 자식 법제처·NTS 프로세스의 경로, 선택된 Python interpreter/cwd, 실제 pip freeze 일치도 확인했다. systemd의 유효한 unit/drop-in 참조·hash, 새 drop-in 전문, 실제 `TimeoutStopSec=90`, `MemoryMax=671088640`, 영속 교정 디렉터리 및 안전한 환경 항목을 함께 기록했다. 서비스와 ingress는 변경하지 않았다.

[고정 커밋의 격리 재빌드 기록](evidence/research-harness-build-provenance-20260921.json)에는 앱 커밋 `75314179…`의 깨끗한 별도 checkout에서 `npm run build`와 `npm pack --ignore-scripts --json`을 실행한 도구 버전·lock hash·47개 payload hash를 기록했다. 재빌드 tarball SHA는 `a5b584df7b82179a11cc0dea5620596cf7aba80f44c81bccef66524a4d2c597d`로 두 Linux CI 로그의 값과 정확히 같다. 이 작업은 배포 후의 소스 대응 확인이며 원래 CI artifact를 다운로드했다고 주장하지 않는다.

운영 tarball `d63b301d…9464ce6`과 재빌드 tarball은 45개 파일이 바이트 단위로 같고, 아래 두 파일만 줄바꿈이 다르다. 모든 실행 코드와 MCPB는 같다. 두 파일 모두 CRLF를 LF로 바꾸면 정확히 일치하며 도구 목록의 파싱된 JSON도 같다. 원래 배포 tarball 자체에 대한 clean-install/stdio/SSE 등 7개 통과 기록도 해당 hash에 결합했다.

| 경로 | 운영 파일 | 고정 소스 재빌드 | 차이 |
| --- | --- | --- | --- |
| `LICENSE` | 1,086 bytes, CRLF 21개 | 1,065 bytes, CRLF 0개 | 줄바꿈만 다름 |
| `upstreams/korean-taxlaw-mcp.tools.json` | 30,906 bytes, CRLF 1,130개 | 29,776 bytes, CRLF 0개 | 줄바꿈만 다름, JSON 값 동일 |

마지막 정리 점검에서는 이번 작업의 실패 후보 폴더 두 개만 제거했고, 운영·이전 릴리스·실제 공유 법제처 경로를 보존했다. 작업 소유 fence가 없고 같은 운영 PID와 release_commit이 유지되며 디스크 여유는 2,036,600,832 bytes였다. 원본 실행 기록과 사후 대조의 시점은 각 JSON에 구분되어 있다. Pro의 공개 HTTPS 직접 조회는 웹 도구 접근 실패로 확인되지 않았으며, HTTPS 실조회는 Codex 실행 증거다.
