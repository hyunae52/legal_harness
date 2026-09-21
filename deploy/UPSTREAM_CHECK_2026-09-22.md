# 2026-09-22 upstream 확인 작업 운영 검증

- 대상: GCE의 `legal-harness-a.service`, 공개 `https://law.taxlab.kr/mcp`.
- 앱 릴리스는 `c650ed8b8f31a2430a5620d001b15c4dd9de4b3e` / 2.4.0을 유지했다. 설정 중 앱 재시작은 없었다.
- 설치 provider: korean-law-mcp 4.13.0, korean-taxlaw-mcp 2.0.0 / `d77c94e5b64892fe85928508544366e418397c71`.
- 확인 script SHA-256: `30db3283d687dc4a77a7ee3bf3d6ff8c4002a8e95e410341ca5db7be667c9932`.
- `/etc/cron.d/legal-harness-upstream-check`를 등록했다. 서버 시간대 `Etc/UTC`, 매일 18:30 UTC = 03:30 KST. 첫 예약 시각은 2026-09-22 03:30 KST다.
- 기존 git-sync / korean-law updater 두 cron의 동결 상태를 그대로 보존했다.

## 실행 증거

1. Windows 및 GCE Linux에서 새 작업의 회귀 시험 7건 통과. 비공개/404, 전체 장애, 이전 정상 후보 보존, 출처별 실패 격리, metadata/응답 크기 검증, runtime pin 변경, 결과 저장의 운영 manifest 불변을 확인했다.
2. GCE에서 예약과 동일한 flock/timeout/node 명령을 수동 실행해 성공했다. lock을 다른 프로세스에서 잡은 상태로 다시 실행하면 즉시 건너뛰고 결과 파일을 바꾸지 않았다.
3. 2026-09-22 01:44 KST 첫 확인 결과: npm 4.13.1 및 해당 원본 커밋 `167660f75fa8275771172aef8c663efee3e00a73` 감지. zisu17 원본 최신 커밋은 설치본과 같았다. 4.13.1은 `validation: pending` 후보로 기록했으며 설치·활성화하지 않았다.
4. 운영 프로세스와 분리한 Linux network namespace에서 네트워크 경로 없이 두 설치본을 새로 실행했다. korean-law-mcp는 10개, korean-taxlaw-mcp는 12개 도구를 정상 등록했다. 원본 저장소 접근이 재시작 전제조건이 아님을 확인했다. 이는 법제처·국세청 원문을 오프라인으로 조회할 수 있다는 뜻은 아니다.
5. 설치 후 공개 HTTPS health의 기존 릴리스·public 모드 및 접속키 없는 MCP 연결의 전체 도구 35개를 확인했다. 앱 PID와 WorkingDirectory는 설치 전후 동일했다.

원격 운영 증거: `/home/cta/upstream-watch-deployment.json`, 최신 확인 결과: `/home/cta/.local/state/legal-harness-upstreams/latest.json`. 로컬 사본은 `.runtime/upstream-watch-deployment.json`, `.runtime/upstream-watch-live-verification.json`에 저장했다. 예약 시각의 자동 실행은 아직 도래하지 않았으며 위 실행 증거는 동일 명령의 수동 검증이다.

이 작업에는 자동 PR 생성이나 운영 upstream 자동 교체가 포함되지 않는다. 변경 후보는 별도의 호환성 검증과 검수를 거쳐 배포한다.
