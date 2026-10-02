# SSS 재검수의 근거 채택·후속 검색 결함 보완

`5d9be5b`의 [SSS 완료 응답](AUTHORITY_SCOPE_PROMOTION_SSS_RESPONSE_2026-10-02.txt)은 CODE REVISE / 출시 HOLD다. 좁은 독립 고지 승격은 수용했으나, 문서를 채택해도 실제 후속 검색을 실행할 수 없는 P1/P2를 찾았다. 두 문제 행은 이전 기준 코드에도 존재했다. SSS는 정적 검토를 수행했고, 아래 실행 재현과 수정 검증은 Codex가 수행했다.

## 변경

- `researchCoverage`: 채택하지 않은 첫 저장 조각이 뒤쪽 채택 조각을 가리지 않도록, 검색 적격성을 통과한 뒤에 문서 키를 중복 제거한다. 현재 revision·issue의 범위와 문서당 한 번 검색하는 규칙을 유지한다.
- `research`: 보조 검색의 exploratory 자료도 실제 근거로 채택했다면 현재 관측 원문에 연결해 세션에 보존한다. 검수 결과에만 있던 의무가 이후 status·runner에서 사라지지 않는다.
- `legalApplicability`: 후속/보조 발견의 선택적 채택 조건을 위 두 경로와 공유한다. 보조 자료를 배경으로만 구별했을 때도 빈 작업 목록과 의무 검색 요구가 충돌하지 않는다. 이는 로컬 추가 재현에서 찾은 같은 경계의 모순이다. 직접/유추 인용, applied/analogy 선언, support 조회의 의무는 유지한다.

원문·manifest·출처 종류·법령 버전·현재 revision·인용 모순 검사를 완화하지 않았다. 법적 근거를 배경 설명으로 거짓 분류하거나 원문의 의미를 잘못 해석하는 문제는 여전히 독립 의미 검수 대상이다. 정책 식별자는 `research-v8-adopted-documents-20261002`다.

## 실행 검증

| 검사 | 결과 |
| --- | --- |
| 분할 원문의 비첫 조각 채택 | baseline `5d9be5b`에서 5 RED. claims·시점·반론 및 applied/analogy 선언 |
| 보조 발견 채택 유지 | baseline에서 2 RED. review에는 의무가 있지만 status에서 사라짐 |
| 보조 발견의 배경 인용 | baseline에서 1 RED. 빈 작업 목록인데 후속 검색 필수로 표시 |
| 관련 회귀 | **100/100 PASS**, skip 0 |
| 기본 작업 폴더 전체 `npm run review` | **334/334 PASS**, skip 0 |
| 기본 작업 폴더 `npm run review:package` | **9/9 PASS**, 별도 prefix 실제 설치 |

새 테스트는 11개다. 뒤 조각을 인용한 실제 서버 검수→status→runner 조회, 조각 순서 변경, 같은 문서의 context 뒤 support 조회, 보조 판례의 direct/analogy 채택, 배경/경과 설명의 유한 종료를 구분했다. 승격 검사는 재연결·요건 이력·jobs·기존 검수 해시가 있는 상태의 저장 실패 원자성과, 실제 계획 변경 후 고지 승격이 과거 검색을 되살리지 않는지 보강했다.

첫 분할 fixture는 실제 서버 단계의 quote 3,000자 제한을 넘었다. 100자 원문 인용으로 고친 뒤 제품 소스를 baseline으로 되돌리고 다섯 RED를 다시 확인했다. 테스트 제한이나 제품 검증을 완화하지 않았다. 배경 대조·뒤 support 조회·누적 상태 보존은 추가 RED라고 세지 않는다. 정확한 로그·소스·설치 패키지 hash와 한계는 [preflight](../evidence/authority-adopted-document-preflight-20261002.json)에 남겼다.

## 기존 모델 실행 보존

pilot-m은 검수 결함이 확인돼 미시작 20건을 취소했다. 시작한 4건은 기존 84개 src/dist 파일이 바뀌지 않은 상태에서 종료했다. 정상 대조·개정·후속 판결 3건은 의미 PASS, 마지막 두 주택 사례 1건은 원래 1,500초 제한에 도달해 최종 답변 없이 시간 초과했다. 답변이 없는 실행의 환각/허위 완료/추가 조건 검증은 `null`로 남겼다.

[취소 배치 기록](../evidence/authority-completion-pilot-m-cancelled-20261002.json)은 완성된 24회 출시 평가가 아니다. 네 원본 실행의 소스가 `5d9be5b`와 일치함을 확인했고, 모든 결과를 보존했다. 별도 worktree에서 준비한 다섯 파일은 네 실행 종료와 원본 hash 확인 뒤에만 기본 폴더에 복사했다. 사용자 README/NEXT_STEPS는 변경하지 않았다.

다음은 이 정확한 수정본의 SSS 코드 재검수와 원래 조건의 새 pilot-n 24회다. 기존 실패나 취소 실행을 재시도 성공으로 대체하지 않는다. main 병합·배포는 아직 하지 않았다.
