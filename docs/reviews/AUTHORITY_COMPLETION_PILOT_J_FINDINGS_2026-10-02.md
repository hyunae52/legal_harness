# pilot-j에서 확인한 추가 결함

pilot-j는 `3eab92ce8460670517cbd845b4ab7fd1d35e0d5a` 소스로 시작했다. 전체 304개와 설치 9개 검사를 통과했고 해당 커밋의 [GitHub Review](https://github.com/hyunae52/legal_harness/actions/runs/36890532295)도 성공했지만, 실제 모델의 호출 순서에서 아래 결함을 확인했다. 후속 실행은 CANCELLED 표식으로 중단하고 이미 시작한 네 실행의 동결 런타임·로그·답변을 그대로 남긴다. 일부 실행의 구조 완료 여부와 관계없이 이 배치는 출시 승인 근거로 사용하지 않는다.

## J-1: 사실 보완이 변경 없는 요건 전체를 이력에 복제

`remaining_two_homes-1`의 처음 8개 호출을 별도 ResearchService에서 재생했다. 쟁점 3개, 사실 9개, 날짜 5개에서 요건 레코드 29개가 만들어졌다. 사실·날짜 답변에 따라 revision만 바뀌었는데도 29개 전체의 before/after가 매번 이력에 복제됐다. 6번 답변 후 이력만 **217,171바이트**였고 7번째 답변이 `RESEARCH_CAPACITY / ledger_bytes`로 거절됐다. 외부 조회는 아직 0회였다. revision을 제외한 요건 내용 변경은 0개였다.

원인: `ResearchService.requirementHistory`가 revision 필드 차이까지 개별 요건의 실제 변경으로 간주했다. 수정은 전체 전후 hash와 revision 전환 이벤트는 유지하되, 요건 내용의 변경이 있을 때만 개별 before/after를 보존한다. 요건 삭제·이름 변경·상태 재평가·근거 초기화는 실제 변경이므로 이전과 같이 기록한다. 운영 저장 한도는 그대로다.

같은 7개 답변은 수정 후 모두 적용됐고 이력은 **2,108바이트**였다. 날짜의 월·연도 정밀도는 그대로이며 source 호출 없이 사실 반영을 마친 뒤 실제 조회를 시작할 수 있다.

회귀 검사는 당시 합성 시나리오의 계획과 답변만 `tests/fixtures/authority-history-plan.json`에 저장한다. 비공개 continuation handle·실행 ID는 포함하지 않는다. 원 소스에서 RED(일곱 번째 답변 429), 수정 후 GREEN을 확인했다. `.runtime/authority-coverage-implementation-20261001/completion-history-red.log`, `completion-history-green.log`, `completion-history-red-replay.json`에 근거를 보존한다.

## J-2: 판례의 관측된 선고일이 문서 버전에 연결되지 않음

`subsequent_change-1`에서 요건 평가가 여러 번 `REQUIREMENT_VERSION_MISMATCH`로 거절됐다. 법령 원문은 시행일을 버전으로, NTS 문서는 생산·결정일을 버전으로 기록하는데 법제처 판례 본문은 선고일을 identity에 읽어 놓고도 `document_version`을 항상 unknown으로 남겼다. 평가자가 관측된 선고일을 제출해도 일치시킬 수 없었다.

판례·결정 본문의 version label에 **동일 응답에서 관측한 선고·결정일만** 연결했다. 원문 hash는 별도로 유지한다. 판례 날짜를 적용 법령의 시행일로 추정하거나 새로운 statute anchor를 만들지 않는다. 날짜가 없으면 unknown을 유지하고 요건 평가를 허용하지 않는다. 잘못된 날짜, 다른 actor·revision·원문 및 부분 본문 거절도 유지한다.

`tests/research-requirements.test.mjs`의 실제 원문 수집 경계를 통해 관측 날짜 있음/없음과 잘못된 version을 대조했다. 원 소스의 RED와 수정 후 GREEN은 `completion-decision-version-red.log`, `completion-decision-version-green.log`에 있다. 두 보완을 포함한 전체 검사는 **306/306 PASS**, 실패·skip 0이다(`completion-full-review-4.log`).

## 다음 평가의 근거

위 두 실제 제품 변경이 새 동결 배치의 재실행 사유다. 입력·모델·시간·서버 예산·의미 판정 기준을 완화하지 않는다. pilot-i 실패 기록과 pilot-j의 시작된 모든 실행은 대체하거나 삭제하지 않는다. 새 배치는 pilot-k이며 모든 24건을 새 소스로 실행한다. 계획 승인·자동검사·소수 실행의 구조 완료는 최종 의미 검수와 구현 Pro 검수를 대신하지 않는다.
