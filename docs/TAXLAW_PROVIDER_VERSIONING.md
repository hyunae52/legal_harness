# 국세법령정보 MCP 포크와 운영 버전 관리

## 결정

`korean-law-mcp`는 현재 설치와 갱신 정책을 그대로 유지한다. 이 문서의 변경 대상은
`zisu17/korean-taxlaw-mcp`를 바탕으로 한 국세청·지방세 자료 제공자뿐이다.

TaxLab은 `hyunae52/korean-taxlaw-mcp` 포크를 검토 기준 저장소로 사용한다. 운영
Legal Harness는 이 포크에서 검토하고 고정한 커밋을 독립 버전 저장소에 설치하며,
요청이 들어올 때 지금과 동일하게 해당 버전의 Python MCP를 `stdio` 자식 프로세스로
실행한다. 별도의 상시 HTTP MCP 서비스는 만들지 않는다.

## 저장소 흐름

```text
zisu17/korean-taxlaw-mcp:main
              |
              | 매일 변경 확인 및 병합 후보 생성
              v
hyunae52/korean-taxlaw-mcp:automation/upstream-zisu17-main
              |
              | Python 3.11/3.13 오프라인 시험 + 사람의 PR 검토
              v
hyunae52/korean-taxlaw-mcp:main
              |
              | 별도 Legal Harness PR에서 commit/hash/schema 고정
              v
Legal Harness 검증 후보 -> 승인 -> 운영 독립 버전 저장소
```

포크의 예약 GitHub Actions는 upstream 코드를 쓰기 권한이 있는 단계에서 실행하지
않는다. 병합 후보 브랜치를 만든 뒤 읽기 전용 시험 단계에서 잠금 파일 기반 오프라인
시험을 수행한다. 시험 성공 시에만 PR을 만들거나 갱신한다.

예약 작업은 다음 동작을 하지 않는다.

- PR 자동 병합
- 패키지 배포
- Legal Harness의 버전 pin 자동 변경
- 운영 설치나 활성 버전 변경
- 운영 서비스 재시작

## 운영 파일 구조

국세법령정보 MCP 설치본은 애플리케이션 릴리스 디렉터리 밖에 둔다. 권장 구조는
다음과 같다.

```text
/home/cta/legal-harness-taxlaw/
  active.json
  <40자리 commit>/
    source.zip
    source/
    venv/
    installed-dependencies.txt
```

systemd 서비스에는 다음처럼 활성 선택 파일의 절대경로를 설정한다.

```text
TAXLAW_MCP_RELEASE_FILE=/home/cta/legal-harness-taxlaw/active.json
```

따라서 Legal Harness 애플리케이션을 새 디렉터리로 배포해도 국세법령정보 MCP의
설치본과 활성 선택은 유지된다. 애플리케이션은 시작할 때 `active.json`을 읽고,
각 요청에서는 그 파일이 가리키는 Python과 작업 디렉터리로 MCP 자식을 실행한다.

## 업데이트 절차

1. 포크의 자동 후보 PR에서 upstream 차이와 오프라인 시험 결과를 확인한다.
2. 필요한 TaxLab 수정과 충돌 여부를 검토한 뒤 포크 PR을 사람이 병합한다.
3. Legal Harness PR에서 `upstreams/korean-taxlaw-mcp.json`의 저장소, 커밋,
   아카이브 SHA-256, 버전과 도구 스키마를 함께 갱신한다.
4. 새 커밋을 운영과 분리된 후보 디렉터리에 설치한다.
5. 단위·통합·실제 조회 smoke test를 실행하고 기존 실패사례를 재검증한다.
6. 검증 결과를 사람이 승인한 뒤에만 운영 독립 저장소의 `active.json`을 원자적으로
   교체하고 Legal Harness 서비스를 재시작한다.
7. `/health.taxlaw_release`, 도구 목록, 대표 원문 조회를 확인한다.

실패하면 기존 `active.json`과 기존 버전 디렉터리를 유지한다. 다운로드 실패,
시험 실패, GitHub 접근 실패를 이유로 이전 운영 버전을 삭제하거나 자동 전환하지
않는다.

## 매일 감시의 역할

VPS cron은 읽기 전용 상태 감시다. 실행 중인 버전, 포크 `main`, 원본
`zisu17/main`의 관계를 기록하고 후보 존재 여부를 알리지만 코드를 설치하거나
서비스를 재시작하지 않는다. GitHub 쓰기 권한은 VPS에 저장하지 않는다.

포크 `main`이 운영 커밋보다 앞서면 검증할 새 운영 후보로 보고한다. 원본만 변경되고
포크 PR이 아직 병합되지 않았다면 upstream 동기화가 필요한 상태로만 보고하며,
그 원본 커밋을 운영 후보로 직접 활성화하지 않는다.

## 현재 기준

- 검토 포크: `hyunae52/korean-taxlaw-mcp`
- 원본 저장소: `zisu17/korean-taxlaw-mcp`
- 현재 고정 커밋: `50a2093170367dcf51f1273116b0fd032d3b8fdf`
- 현재 패키지 버전: `2.0.0`
- 실행 방식: Legal Harness가 요청 시 Python MCP를 `stdio` 자식으로 실행
- 운영 전환: 시험 완료 후 사람의 명시적 승인 필요

커밋과 버전의 실제 운영값은 이 문서가 아니라
`upstreams/korean-taxlaw-mcp.json`과 운영 `active.json`을 기준으로 판단한다.
