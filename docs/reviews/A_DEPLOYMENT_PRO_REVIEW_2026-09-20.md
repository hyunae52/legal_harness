# A 배포 준비 — 1차 Pro 검수와 보완

실제 [6 Pro 대화](https://chatgpt.com/c/6aae9b76-b7d8-83e8-b743-71f206c6b9dd)에서 11분 22초 검수 후 **DEPLOYMENT PREPARATION REVISE / 운영 HOLD**를 받았다. 대상 H는 `c1fadedc51635acecb178f1d6ada83342e279c72`, 패킷 SHA-256은 `0589407d6d8c8c17b2097ede653d11be4547e9eab62c09f3218b49e3c0cb69cb`다. 기존 조회 runtime CODE PASS와 A/B PLAN PASS는 유지됐다. 최신 정확한 H의 재검수 판정·CI는 [PR #3](https://github.com/hyunae52/legal_harness/pull/3)에 기록한다.

Pro는 패킷 및 포함 파일 20개 hash를 대조했고, GitHub 제공자에 직접 접속하여 run `35491064441/attempt 1/job 106025960066`, checkout H, 모든 step success, 68/68·skip 0, package 6개 및 artifact digest를 확인했다. 전체 시험을 재실행하거나 GCE에 접속한 것은 아니다. GCE cold-start/부하/설치/클라이언트/복구는 구현자 관찰로 구분했다.

| 필수 지적 | 보완과 해당 검증 |
|---|---|
| DP-1/P2: `ps`에서 updater 경로만 찾으면 아직 사용자 명령을 exec하지 않은 CRON 자식을 놓침 | 검수된 `KillMode=process`에서 scheduler를 일시 정지하고 inactive/MainPID=0·pre-exec CRON/실행 작업 0을 확인한 다음 두 줄만 동결. 검증 후 scheduler 재개. 합성 포트 경합과 실제 Linux SIGSTOP 자식의 HOLD를 시험한다. 운영 cron의 실제 정지는 마지막 승인 후다. |
| DP-2/P2: version 문자열이 같은 upstream·전이 의존성 파일 변경을 통과시킴 | 전체 설치 트리의 파일 내용·경로·종류·링크를 fingerprint로 고정. 동일 tar/shrinkwrap의 새 clean 설치 6,679파일/9링크가 후보와 일치함을 실제 대조. 완전한 검증기에 버전 유지 JS 변경·전이 변경·파일 누락·링크 교체를 넣어 모두 거부한다. |

권고 1은 실제 cloudflared 프로세스가 `/etc/cloudflared/config.yml`을 쓰는 증거를 추가했다. 권고 2인 일반 조회+별도 freshness child 동시 자원 시험은 현재 15분 시험의 범위가 아님을 명시했다. Pro는 이를 필수 차단점 또는 현재 OOM으로 판정하지 않았다.

재검수 준비 중 가비아 로그인 후 전체 DNS 8개를 확인하여 Cloudflare에서 누락된 `_dmarc.dev` TXT 1개도 발견했다. 보존할 전체 목록·TTL과 누락 복사를 실행안에 추가했다. 실제 NS·DNS·방화벽·공개 route·merge는 변경하지 않았다. 변경된 설치 manifest와 B/H/T의 재검수, 마지막 사람 승인, 실제 전환 후 검증이 남아 있다.
