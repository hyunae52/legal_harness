# 해석 검토 v2 (2.5)

사용자의 AI가 법률 해석을 수행하고 MCP가 그 해석의 적용 구조·근거·검토 이력을 관리한다. 별도의 서버 LLM, 유료 API, 벡터 DB, DB migration은 필요 없다. 법령·판례의 실제 의미를 서버가 정답으로 인증하는 기능은 아니다.

## 달라진 동작

| 이전 흐름 | v2 |
| --- | --- |
| 주장과 인용을 대조 | 요건·예외·재예외별 사실·날짜·원문 및 적용 이유를 연결 |
| 자유 서술로 요건 판단 | AND/OR/NOT 조합의 충족·불충족·미상을 구분. 미상을 부정해도 참으로 바꾸지 않음 |
| 반론 처리 이유 기록 | 대립하는 명제와 원문, 법령·시점·사실 차이, 채택 이유 및 가장 강한 반론을 함께 기록 |
| 제출한 주장 중심의 구조 검사 | 순서가 고정된 답변 전체를 원문과 함께 모델 검토에 제공. 참고 문맥에 숨은 단정도 검토 대상 |
| 수정 뒤 지적의 연속성 약함 | 지적 ID, 작성자의 수정 제안·이견, 후속 모델 검토를 별도 보존. 누락·삭제만으로 지적이 닫히지 않음 |
| 키워드 적중으로 질문 룰 선택 | 후보 발굴과 적용 판단을 분리. 사실에 연결한 적용·제외 이유를 받고 중복 질문을 합침 |

## 사용하는 AI의 순서

1. 기존 연구 도구로 쟁점·사실·적용일과 원문·반대·후속 자료를 확보한다. 단순 법령 조회에는 이 절차를 강제하지 않는다.
2. `review_legal_reasoning`에 `reasoning_contract_version: 2`, `legal_tests`, 각 주장별 `test_expression`, `application`, `test_result`, `excluded_tests`, `authority_conflicts`, `strongest_opposition`, `answer_blocks`를 제출한다. 전체 `draft_answer`는 블록의 text를 두 줄바꿈으로 결합한 것과 정확히 같아야 한다.
3. 반환된 `artifact_id/artifact_hash`로 `prepare_reasoning_review`를 호출한다. 요청마다 새 `request_id`와 현재 revision/state_version을 사용한다.
4. `get_legal_research(view: "review_packet")`로 같은 packet과 manifest의 모든 페이지를 읽는다. 요약이나 ID 목록만 받은 것은 원문 제공 완료가 아니다. 다음 페이지 cursor는 제공 이력 때문에 무효화되지 않는다.
5. 연결한 AI가 원문·전체 답변·적용표·반론·이전 지적을 검토하고 `submit_reasoning_review`로 `revise`, `qualified`, `no_detected_issue` 중 하나를 기록한다. 제한 사항은 실제 답변 구절에 연결한다.
6. 지적 수정은 다음 구조 검사에 `finding_responses`의 `proposed_fix` 또는 `disputed`로 제출한다. 이후 새 packet을 읽은 검토가 같은 ID를 명시적으로 다뤄야 닫힌다. 서버 검사와 관련된 지적은 현재 `structure_gap_ids`에 연결하며 해당 검사 오류가 실제로 사라져야 닫힌다. 무관한 공백은 개별 지적의 해소 기록을 막지 않고 전체 준비 상태를 별도로 차단한다.

같은 모델의 검토는 `self_review`, 다른 모델이라고 클라이언트가 보고하면 `client_reported_review`다. 두 경우 모두 독립성은 서버가 확인하지 않았으므로 `independent_review=not_performed`를 유지한다. 검색 0건이면 수행한 검색 ID와 범위를 남기고 반례를 만들어내지 않는다.

## 상태와 한도

`ready_for_answer=true`는 현재 연구 자료·정확히 같은 답변에 대해 구조가 갖춰지고, 필수 검토 자료가 모두 제공되었으며, 검토 제출이 수락되고, 차단 지적이 없다는 뜻이다. `legal_verification`과 `semantic_support`는 계속 `unverified`다. 새로운 사실·원문·적용 범위·필요성 판단·답변이 바뀌면 이전 검토는 현재 효력을 잃는다. 준비·페이지 제공 같은 관리 기록만 바뀐 경우에는 스스로 무효화하지 않는다.

수락된 모델 검토는 연구당 최대 3회다. 준비·페이지 읽기·불완전 제출·실패·같은 요청 재전송은 횟수에 포함하지 않는다. revision이나 request ID 변경으로 한도를 초기화하지 않는다. 만료 전의 수락 영수증을 64개/64KiB 이내에서 보존하며, 초과 시 새 요청을 거부하고 과거 영수증을 몰래 지우지 않는다. 재전송은 현재 준비 상태와 과거 처리 결과를 분리해 반환한다.

연구는 기존과 같이 메모리에만 남으며 30분 또는 서버 재시작 때 사라진다. 기존 1MiB/연구, 전체 8MiB 예산 내에서 검토용 공간을 확보한다. 제한에 걸리거나 검토를 마치지 못해도 공백을 밝힌 조건부 답변은 가능하다. 완료된 검수인 것처럼 표시해서는 안 된다.

## 운영 전환

기본 `REASONING_REVIEW_V2_ENABLED=false`다. 승인된 후보의 코드 검수, 자동 회귀·패키지·보안 검사, 고정 합성 사례의 모델 비교를 완료한 뒤 운영 환경에서 `true`로 설정하고 재시작한다. `/health`의 `reasoning_review`와 실제 MCP 도구 목록·REST/MCP 왕복을 함께 확인한다. 꺼져 있으면 두 새 도구는 MCP 목록에 없고 v2 요청은 명시적으로 거부한다. v1 조회·검사는 유지되지만 v2 준비 완료로 승격되지 않는다.

문제가 생기면 플래그를 `false`로 돌리고 재시작한다. 앱 자체 회귀이면 자동 배포기의 직전 검증 릴리스 복구 절차를 사용한다. 꺼진 동안 v1 결과를 v2 성공으로 대체하지 않는다. main 병합·자동 배포의 결과와 실제 플래그 상태는 배포 기록에서 따로 확인한다.

## 검증 범위

계획의 IR-01~29에 대한 적용·상태·전송 검사는 `tests/reasoning-v2.test.mjs`, `tests/reasoning-transport.test.mjs` 및 기존 authority/coverage/scope 회귀에 분산되어 있다. 테스트 이름의 IR 번호는 탐색용이며 승인 조건은 계획의 표와 실제 assertion으로 판단한다. IR-21 변이 검사는 `scripts/check-reasoning-mutations.py`, IR-22 모델 비교는 `scripts/run-reasoning-model-pilot.py`로 실행한다.

모델 비교는 사전 고정한 가상 법령 12개, 보류 사례 4개, 기존/신규 각 3회다. 원문 탐색은 양쪽에 동일하게 선행 제공하고 해석·검토 절차를 비교한다. 따라서 이 시험은 실제 세법 정답률이나 검색 재현율을 증명하지 않는다. 결과와 실행 후보의 hash는 별도 검증 기록에 보관한다.
