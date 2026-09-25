# 두 MCP의 원본 보존과 매일 변경 확인

운영 서버는 `chrisryugj/korean-law-mcp`의 설치된 Node 패키지와 `hyunae52/korean-taxlaw-mcp`의 검토된 Python 가상환경을 stdio로 실행한다. `zisu17/korean-taxlaw-mcp`는 변경 확인 대상이며 운영 실행 대상이 아니다. 요청 처리나 재시작에 GitHub 다운로드를 하지 않는다. 원본 저장소가 비공개로 바뀌어도 현재 설치본은 유지된다. 법제처·국세청 원문 조회에는 해당 기관에 대한 네트워크 연결이 필요하다.

서버 디스크 유실 후의 새 설치는 별도 문제다. zisu17의 원본 ZIP과 hash는 서버에 보관하지만, 전체 VM·모든 의존성을 독립적으로 복원할 백업을 검증한 것은 아니다. 기존 릴리스 디렉터리는 현재 release manifest에서 참조할 수 있으므로 경로를 확인하지 않고 지우면 안 된다.

## 현재 운영 예약

- `/etc/cron.d/legal-harness-upstream-check`: 매일 18:30 UTC, 한국시간 다음 날 03:30. 설치 전에 서버 시간대가 `Etc/UTC`인지 확인한다.
- 실행 코드: `/usr/local/lib/legal-harness/check-upstreams.mjs` (`scripts/check-upstreams.mjs`의 검증한 사본).
- 최신 결과: `/home/cta/.local/state/legal-harness-upstreams/latest.json`.
- 실행 로그: 같은 디렉터리의 `check.log`. 로그는 주 단위 또는 1 MiB 초과 시 회전하고 4개를 보관한다.
- 상태 디렉터리 `0700`, 결과·로그 `0600`. GitHub 토큰이나 API 접속키를 사용하지 않는다.
- 메일 기록: Gmail SMTP 앱 비밀번호를 사용하는 `upstream-email.env`를 서버에만 `0600`으로 보관한다. 매 실행 결과를 메일로 보내며, 같은 `status + checked_at` 실행만 중복 차단한다. 앱 비밀번호와 SMTP 원문 오류는 로그·Git·상태 파일에 기록하지 않는다.

실행마다 systemd의 현재 WorkingDirectory와 프로세스의 release manifest 위치를 읽어 **실제 실행 중인 버전**과 비교한다. 앱을 새 릴리스로 전환하면 다음 확인부터 새 설치본을 기준으로 한다. 프로세스가 읽는 도중 교체되거나 설치 pin이 맞지 않으면 실패로 기록하고 설치본을 건드리지 않는다.

확인 대상은 npm의 `korean-law-mcp@latest`, 법령 MCP 저장소, 국세법령정보 MCP의 원본 `zisu17/main`과 검토 포크 `hyunae52/main`이다. 설치된 npm 버전의 원본 커밋은 npm metadata의 `gitHead`로 대조한다. 포크의 새 커밋 중 실행 코드·패키지 설정에 영향을 주는 변경만 운영 검증 후보가 되며, `.github`, 문서, 시험만 바뀐 커밋은 후보에서 제외한다. 비교 파일 목록이 없거나 300개 이상으로 잘리면 안전하게 실행 변경으로 취급한다. 원본에만 있는 변경은 `upstream_sync_required`로 기록하고 직접 운영 후보로 승격하지 않는다. 이 확인은 법령 내용의 최신성 검증과는 별개다.

## 결과와 업데이트 범위

- `current`: 확인한 최신 배포 버전·커밋이 설치본과 같다. npm latest가 더 오래된 버전이면 설치본을 유지하고 원본 조회값을 결과에 남긴다.
- `updates_available`: 새 버전이나 변경 커밋이 있다. `candidates`에 버전·커밋과 `validation: pending`을 기록한다. `activation: fork_review_required`는 포크 동기화 PR이 먼저 필요하고, `activation: human_review_required`는 검토 포크의 커밋을 Legal Harness 후보로 검증할 수 있다는 뜻이다.
- `partial`: 비공개 전환, 삭제, API 한도, 응답 형식 오류, 통신 실패 등으로 일부 출처를 확인하지 못했다. 마지막 정상 확인값과 시각을 보존하되 `unavailable`로 표시한다. 다른 출처의 확인은 계속한다.
- `check_failed`: 실행 중인 설치본이나 상태 파일을 읽지 못했다. 직전 결과 파일은 유지하고 로그에 실패 시각을 남긴다.

예약 작업은 **변경 감지만** 한다. 후보 다운로드·설치, 호환성 시험, AI 검수, PR 생성, merge, 운영 버전 전환을 자동 수행하지 않는다. 변경 후보는 별도 검증·검수 후 승인한 앱/규칙/upstream 묶음으로 배포한다. 특히 Hyunae 검토 포크 제공자는 앱에 기록한 commit/version pin과 실제 설치본이 같아야 한다.

`flock`으로 겹친 실행을 건너뛰고 전체 실행을 120초, 각 HTTP 조회를 15초·512 KiB로 제한한다. redirect와 raw 원격 오류 본문을 받지 않으며 상태 파일은 atomic rename으로 저장한다. 저장소 접근 실패가 운영 프로세스를 중단하거나 설치본을 제거하는 경로는 없다.

운영자가 즉시 확인할 때도 예약과 동일한 명령을 사용한다.

```sh
flock --nonblock --conflict-exit-code 0 /home/cta/.local/state/legal-harness-upstreams/check.lock \
  timeout --kill-after=5s 120s /usr/bin/node --max-old-space-size=96 \
  /usr/local/lib/legal-harness/run-upstream-watch.mjs \
  --service legal-harness-a.service \
  --state-dir /home/cta/.local/state/legal-harness-upstreams \
  --email-config /home/cta/.config/legal-harness/upstream-email.env
```

메일 제목은 `[정상]`, `[업데이트 발견]`, `[점검 일부 실패]`, `[점검 실패]`, `[복구]`로 구분한다. 본문에는 운영 중인 두 MCP 버전·변경 후보·조회 출처 상태를 남긴다. 발송이 실패하면 `notification_failed`만 로그에 출력하고 다음 예약에서 다시 시도한다.

이전 `/opt/legal_harness/scripts/cron-git-sync.sh`와 `update-korean-law.sh` cron은 동결 상태를 유지한다. 이 작업들은 현재 systemd 배포 방식과 호환되지 않으며, 새 확인 작업과 함께 켜지 않는다.
