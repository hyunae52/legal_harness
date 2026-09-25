# 2026-09-25 국세법령정보 MCP 버전 관리 적용 기록

## 적용 결과

- `korean-law-mcp`의 설치 버전과 운영 구조는 변경하지 않았다.
- `hyunae52/korean-taxlaw-mcp`를 검토 포크로 확정했다.
- 포크 PR `#1`을 병합해 중복 문서번호 수정과 upstream 후보 자동 생성
  워크플로를 `main`에 반영했다.
- 예약 워크플로를 수동 실행해 성공을 확인했다. 당시 원본 `zisu17/main`은 포크가
  이미 포함한 상태여서 새 후보 PR을 만들지 않았다.
- 운영 Taxlaw 설치본을 애플리케이션 릴리스 밖의
  `/home/cta/legal-harness-taxlaw`로 설치했다.
- `legal-harness-a.service`는
  `/home/cta/legal-harness-taxlaw/active.json`을 읽도록 전환했다.
- 앱 릴리스 `7d73992adc96a667124bba048c8c9d894186ec14`와 Taxlaw 실행 커밋
  `50a2093170367dcf51f1273116b0fd032d3b8fdf`는 그대로 유지했다.

## 검증

- 포크 오프라인 시험: 285개 통과
- Legal Harness 전체 시험: 182개 통과
- upstream 감시기 집중 시험: 10개 통과
- 독립 저장소 실제 국세청 smoke test: 13회 호출, 대표 문서 5건 통과
- 중복 문서번호 `법인46012-1784`: 번호만 조회하면 유보, `퇴직금` 맥락을 주면
  지정 문서로 해소되는 것을 확인
- 서비스 전환 전 공개 요청을 차단하고 active request/authentication/dispatch가 모두
  0인 상태에서 재시작
- 전환 후 새 프로세스가 독립 `active.json` 경로를 읽는 것을 확인
- 공개 `https://law.taxlab.kr`에서 health, 22개 법령·세법 조회 도구,
  `lookup_tax_document` 실호출 성공과 provider commit을 확인

## 감시 정책 검증

운영 cron은 원본 `zisu17/main`과 검토 포크 `hyunae52/main`을 별도로 확인한다.
원본에만 있는 변경은 포크 검토 대상으로 기록하고 직접 운영 후보로 만들지 않는다.
포크의 실행 코드·패키지 설정 변경만 운영 검증 후보가 된다.

포크 병합 커밋 `2958dafd49e2c8f53455c08e510cc6b8f202aec1`은 현재 실행 커밋보다
앞서 있지만 차이가 `.github/workflows/upstream-sync.yml`, `README.md`,
`docs/FORK_MAINTENANCE.md`뿐이므로 운영 Taxlaw 후보에서 제외되는 것을 확인했다.

최종 운영 감시기의 SHA-256은
`37dc276a67cd1c83bf0440fc0f490f860a801116026e59b7f9483de59ec513da`다.
감시기는 설치, 자동 활성화, PR 병합, 서비스 재시작을 수행하지 않는다.

## 관련 문서

- [국세법령정보 MCP 포크와 운영 버전 관리](../docs/TAXLAW_PROVIDER_VERSIONING.md)
- [두 MCP의 원본 보존과 매일 변경 확인](../docs/UPSTREAM_WATCH.md)
- [국세청·지방세 자료 제공자 연결](../docs/TAXLAW_INTEGRATION.md)
