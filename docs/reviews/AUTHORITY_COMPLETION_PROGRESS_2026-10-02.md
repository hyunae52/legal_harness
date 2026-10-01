# 완료 경로 보완 진행 기록

기준 HEAD: `1aa530c468c040a44b0ebccb4747f45fb7958d93`. 기존 실행 소스 `f17e5655551e45178a93b7d6a2c1b8af9c071635`와 동일하다. [계획](../AUTHORITY_COVERAGE_COMPLETION_FIX_PLAN.md)의 CF 계약을 구현하는 작업이다. 기존 24건 22 PASS / 2 FAIL은 보존하며 출시 차단 상태를 유지한다.

## 계획 검수

2026-10-02 기존 Chrome 검수 대화에서 실제 Pro와 `Simdorei Local Project Oauth` 연결을 확인하고 읽기 전용 계획 검수를 요청했다. 초기 연결 검증 실패 후 허용된 한 번의 재시도로 `verified`를 받았다. 과거 사용량 제한을 현재 제한으로 취급하지 않았다.

대화: https://chatgpt.com/c/6abe1ed3-1050-83ee-99d7-d681aa03cf0b

판정: **PLAN PASS**, 구현 착수에 필요한 계획 승인. [완료 응답](AUTHORITY_COMPLETION_PLAN_PRO_RESPONSE_2026-10-02.txt)을 보존했다. 계획 검수 대상 SHA-256은 `086ade18fb6d15dc49d470093d7f2cb672ffe63b5df5c0722462069b53d53dae`이다. 추가 계획 차단 지적이 없어 불필요한 재검수는 하지 않는다. 검수자가 실제 코드의 귀속 교체와 무조건 필수 질문 생성을 확인했다. 기존 시험 원시 로그의 재구성·HEAD 동일성 독립 확인·새 구현 시험은 검수 범위 밖이다.

Pro로 전송하고 생성 중 Pro 표시를 확인했다. 응답 완료 뒤 서비스 사용량 제한 안내와 다음 입력의 Medium 선택이 나타났다. 후속 요청을 Medium으로 전송하지 않았다. 최종 구현 검수 시 Pro 사용 가능 여부를 다시 확인한다.

## 테스트 우선 재현

제품 코드를 변경하기 전에 `tests/research-harness.test.mjs`에 실제 HTTP 서비스 경계를 통한 회귀 검사를 추가했다. 외부 제공자만 합성 fixture로 대체했다.

| 계약 | 새 실행 및 관측 | 근거 |
| --- | --- | --- |
| CF-01~03 | 4개 RED. 같은 revision 귀속이 I3만 남음, 좁은 검색 맥락 소실, 새 revision의 두 번째 귀속도 덮어씀, 무변경 재사용이 검수 상태를 갱신함. | `.runtime/authority-coverage-implementation-20261001/completion-a-red.log` |
| CF-04~05 | 2개 RED. 한도 초과 자체는 거절하나 메타데이터/조회 횟수 원인을 응답하지 않음. | `completion-b-red.log` |
| CF-07 | RED. 참조 namespace 안내가 없음. 존재 여부 assertion을 명시한 재확인에서도 동일 결함. | `completion-c-red.log` |
| CF-08 | RED. 원문 근거가 없는 가설을 바로 확정된 사실 질문으로 안내함. | `completion-c-red.log` |
| CF-06/12 | RED. 실제 MCP 응답에 명시적 bounded-summary 계약이 없음. 전체 본문과 계획이 기본 진행 응답에 섞임. | `completion-summary-red.log` |

명령은 `node --test --test-name-pattern='CF-0[123]' tests/research-harness.test.mjs` 및 `[457]`, `[78]`, `CF-06` 선택이다. 총 9개 별도 회귀 검사가 의도한 제품 동작 차이로 실패했다. 동일 테스트를 중복 실행했다고 통과 수를 늘리지 않는다. 이 표의 RED 이후 구현·GREEN·회귀 근거를 이어 기록한다.

기존 전체 284개·설치 9개 검사 근거는 이전 소스의 결과다. 아래에는 새 구현에서 수행한 결과만 구분해 기록한다.

## 구현 결과

- A: 같은 revision의 원문 재사용은 쟁점 귀속을 합집합으로 누적한다. 새 revision에서는 명시한 쟁점으로 시작하며, 동일 연결 재전송은 상태와 검수를 무효화하지 않는다. 원문·hash·조회 시각은 보존한다.
- B: 조회 횟수·본문·메타데이터·공유 예약 등 한도 원인을 구분하고, 남은 작업과 복구 경로를 돌려준다. 기본 진행 응답은 32KiB 이하 요약이며 전체 계획·후보·이력은 명시적 페이지, 본문은 선택 조회로 읽는다. 검수는 전체 서버 상태를 사용한다. 저장 한도 안에 고정 검수 공간을 예약해 조회가 막혀도 검수 경로를 유지한다. 기존 운영 예산과 모델 시간 제한은 늘리지 않았다.
- C: 사실 값과 요건 필요성을 분리했다. 근거 없는 가설은 `unresolved`, 실제 근거가 있는 요건은 `required`, 질문 범위에서 제외한 조건은 원문·버전·이유와 함께 `not_required_for_question`으로 기록한다. 사실의 unknown 값은 보존한다. 필요성만 수정하면 revision과 원천 조회는 유지하되 CAS와 검수 무효화를 적용한다. 이름 변경·삭제 이력, 최종 법령 적용 검토와의 연결, 자유서술 유보 조건의 근거도 검사한다.

서버가 보장하는 것은 인용·버전·쟁점·상태 연결이다. 원문이 선언한 요건을 의미적으로 뒷받침하는지와 최종 답변의 진위는 독립 모델 출력 검수가 필요하다. 조건 필드가 채워진 것만으로 법률 판단을 인증하지 않는다.

## 새 구현 검증

| 검증 | 결과 | 근거 |
| --- | --- | --- |
| A 귀속 회귀 | 4/4 PASS, 기존 관련 회귀 43/43 | `completion-a-green.log`, `completion-a-regression.log` |
| 한도·참조 안내 | 3/3 PASS | `completion-b1-green.log` |
| 실제 MCP 요약·페이지·본문 | 1/1 PASS | `completion-b2-green.log` |
| 요건·인터뷰·REST 경계 | 26/26 PASS | `completion-requirements-green-3.log` |
| 최종 전체 검사 | **304/304 PASS**, 실패·skip 0 | `completion-full-review-2.log` |
| 깨끗한 prefix에 패키지 설치 | **9/9 PASS** | `completion-package-1.log` |
| 저장소 비밀 검사 / 운영 의존성 감사 | 발견 0 / 취약점 0 | preflight 근거 JSON. 새 커밋 이후 비밀 검사를 다시 적용한다. |
| 저장 본문 제한 재생 | 두 실패 경로 PASS | `completion-bounded-replay.json` |
| 새 필요성 갱신의 MCP·Actions 계약 | 1/1 PASS | `completion-actions-green.log`; 실제 SDK 갱신과 공개 두 스키마에서 평가만/계획만 허용, 동시 입력·CAS 누락 거절 |

경로의 기준 폴더는 `.runtime/authority-coverage-implementation-20261001/`이다. 처음 전체 검사는 300건 중 11건 실패했고 원본 로그를 보존했다. 바뀐 계약을 검증하도록 fixture를 고쳤다. 요건을 묻는 검사는 먼저 실제 합성 본문 근거를 등록하고, 전체 객체 검사는 명시적 full 읽기를 사용한다. 기존 작은 저장 한도 fixture는 새 요건 메타데이터·검수 예약을 포함하는 경계로 조정했다. 실제 운영 한도, 실패 oracle, 인용 검증, 필수 후보 조사 의무를 완화하거나 테스트를 skip하지 않았다.

추가 요건 검사도 제품 수정 전 RED를 확보했다(`completion-requirements-red.log`, `completion-requirement-link-red.log`). 이후 추가한 페이지 전수 확인과 한도 소진 후 검수 검사는 최초 실행이 GREEN이므로 RED라고 기록하지 않는다.

제한 재생은 pilot-i의 실제 저장 passage를 바이트 그대로 사용했다. 원래 제공자 envelope 전체는 저장되어 있지 않아 법령명·시행일·조문 제목 wrapper만 재구성했다. 원본 응답 전체 hash 동일성이나 모델 통과를 주장하지 않는다. I1/I2/I3 연결 유지, 기존 취득 순서 검색 맥락 유지, 7,435바이트 진행 요약, 한도 내 13,111바이트 메타데이터를 확인했다. 추가 조건 평가에서도 사실·revision·원문 조회 기록을 보존했다.

## 모델 재평가를 시작하기 전 고정 조건

새 배치는 `pilot-j`에 보존한다. 원래 8개 입력×3회, `gpt-5.6-sol/xhigh`, Codex CLI 0.159.0, 회당 1,500초 제한, 기존 서버 예산을 그대로 사용한다. 원래 프로토콜 SHA-256은 `e2ae3e76f410d850b274116776c8fa8c37f4186b2274e79275360a05682429dd`이다. CLI의 기존 전역 바로가기가 사라진 파일을 가리켜, 같은 0.159.0을 평가용 `.runtime` 안에만 설치했다. 사용자 전역 설정은 바꾸지 않았다.

각 실행은 TS·JS·규칙·제공자 목록·평가 서버와 실행기를 복사하고 hash로 고정한다. 새 계약은 `research-response-v2-20261002`, 새 연구 정책은 `research-v6-completion-recovery-20261002`이다. 추가 합격 기준은 이미 승인된 계획 §8의 동일 사례 예산 재시작 금지와 근거 없는 추가 조건 유보 금지이며, 원래 판정과 함께 적용한다. 기존 실패 두 건을 바꾸거나 단독 재시도로 대체하지 않는다.

아직 **새 모델 평가·최종 구현 Pro 검수·main 병합·배포는 완료하지 않았다.** 전체 자동검사 통과만으로 출시 승인이라고 하지 않는다.

## pilot-j 중간 결함 보완

pilot-j에서 사실 보완 이력의 중복 저장과 판례 문서 version 미연결을 관측했다. 후속 시험 시작을 취소하고 시작된 네 실행은 동결 런타임에서 종료까지 보존한다. [원인·수정·RED/GREEN 기록](AUTHORITY_COMPLETION_PILOT_J_FINDINGS_2026-10-02.md)에 두 변경의 근거를 남겼다. 보완 후 전체 **306/306 PASS**다. 출시 평가는 같은 원래 조건의 새 전체 배치 pilot-k에서 수행하며, 취소한 배치의 성공 실행으로 대체하지 않는다.

## pilot-k 전체 결과와 조회·복구 보완

`33ce577c5b735ab5eeb32cfa7ad50579fbd86ca7`의 24회는 **20 의미 PASS / 4 FAIL**이다. 정상 1→2주택 대조 3회는 모두 `structurally_complete`다. 단순 법령 조회에서 연구를 만든 2회, 후속 판례 인용 관계를 수정하다 시간 초과한 1회, 실제 예규 요약에서 `고가주택 제외`를 빠뜨린 1회를 실패로 보존했다. 시간 초과에는 최종 답변이 없어 환각·허위 완료의 부재를 검증했다고 하지 않는다. 따라서 증거 게이트는 `unverified`이고 출시 승인도 아니다. [24회 결과](../evidence/authority-completion-pilot-k-20261002.json)에 각 답변의 한계와 미완료 상태를 따로 기록했다.

[K 발견 기록](AUTHORITY_COMPLETION_PILOT_K_FINDINGS_2026-10-02.md)에 따른 변경을 격리 폴더에서 준비하고, 24회가 종료하고 원래 `src`·`dist` 82개 hash 불변을 확인한 뒤 합쳤다. 공식 법령 탐색 링크를 원문과 분리하고 단순 조회의 안내를 명확하게 했으며, 누락된 작업 핸들과 인용 관계 오류의 수정 방법을 추가했다. 세션 접근권·인용 모순 차단·조회 예산·평가 입력과 제한은 유지했다.

보완 후 전체 **309/309 PASS**, 별도 prefix의 설치 패키지 **9/9 PASS**다. [세 번째 preflight](../evidence/authority-completion-third-preflight-20261002.json)에 소스와 로그·패키지 hash를 기록한다. 새 24회 `pilot-l`은 같은 원래 프로토콜로 별도 보존하며 기존 실패를 대체하지 않는다. 모델 전체 결과와 실제 Pro 구현 검수가 모두 끝나기 전 main 병합·배포는 보류한다.

## pilot-l 완료와 dot 분석 요청

제품 `e3cdac332581dba27c36d8173b05a6e25a18fcde`의 실제 모델 24회는 **23 의미 PASS / 1 FAIL**이다. 정상 대조군 3회 중 2회만 구조 완료했으므로 [출시 게이트](../evidence/authority-completion-pilot-l-20261002.json)는 FAIL이다. 정상 사례의 핵심 답변이 맞더라도 완료 기준을 완화하지 않는다. [실패 기록](AUTHORITY_COMPLETION_PILOT_L_FINDINGS_2026-10-02.md)에 독립 고지 정리로 revision이 증가해 완료했던 필수 검색을 다시 요구한 경로를 남겼다.

한 사례는 모델 실행 전에 readiness 파일 파싱이 실패했다. 원래 실행 시도와 모든 모델 결과를 보존하고, 제품·입력·평가 제한을 유지한 채 실행기만 수정해 그 사례의 첫 실제 모델 실행을 별도 기록했다. 네 Python 경계 검사를 포함한 전용 Node 검사 1/1 PASS를 새로 실행했다. 제품 309개·설치 9개 검사는 변경 범위가 같아 재사용한다.

사용자가 별도로 요청한 SSS dot의 분석을 ChatGPT 웹에서 실제로 전송했고 착수 응답을 받았다. 정상 사례의 revision 경계와 후속 판결을 배경으로 분류하는 경로를 집중 검토 대상으로 전달했다. 계획 Pro 승인과 구현 승인, dot 분석은 서로 다른 기록이며 아직 main 병합·배포하지 않았다.

## SSS 검수와 보완

사용자가 SSS 검수를 요청했고, [완료 응답](AUTHORITY_COMPLETION_SSS_RESPONSE_2026-10-02.txt)의 판정은 **REVISE**다. 고지 승격으로 revision이 바뀌는 실제 실패와, 시점·반론 해소 인용의 후속 검색 누락 경로를 독립적으로 확인했다. SSS의 GitHub 코드 검토와 로컬 실행 검증 범위를 구분한다. 이를 Pro 구현 승인으로 표시하지 않는다.

[최소 계획](../AUTHORITY_SCOPE_PROMOTION_FIX_PLAN.md)에 따라 원천 연구를 보존하는 제한적 고지 승격과 공통 인용 판정을 구현했다. [구현 기록](AUTHORITY_SCOPE_PROMOTION_IMPLEMENTATION_2026-10-02.md)에 RED의 실제 원인과 fixture 수정도 남겼다. 새 전체 검사 **323/323**, 설치 패키지 **9/9 PASS**다. 수정본 SSS 재검수와 동일 조건의 새 24회 평가 pilot-m은 아직 남아 있으며, main 병합·배포하지 않았다.
