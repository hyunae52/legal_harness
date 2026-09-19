# 독립 Pro 코드·배포 검수

- 요청: 수정 후 별도 Pro 모델의 배포 검수.
- 실행: ChatGPT 새 대화의 모델 선택기 **6 Pro**를 확인하고 코드 스냅샷 첨부.
- 대화: https://chatgpt.com/c/6aae9b76-b7d8-83e8-b743-71f206c6b9dd
- 1차 입력 commit: `7309a3776787bd26e58d5137b9122a9904224cab` (로컬 `review/pro-input-20260919` 태그 보존).
- 입력: [53개 파일의 코드·시험·계획 패킷](DEPLOYMENT_PRO_PACKET_2026-09-19_v1.md), SHA-256 `d04450c0c486944b0ab373c4e9b33733bf8af8b1d408416fc0471203f13c7d4d`.
- `.env`의 credential 값과 일치하는 내용이 패킷에 없음을 검사했다. 원본 개인 사건 자료를 포함하지 않았다.
- PR: https://github.com/hyunae52/legal_harness/pull/3 (Draft).

## 1차 판정

17분 32초 처리 후 **전체 production NO-GO / 제한 배포 후보 CODE REVISE·배포 HOLD**. 신규 P1은 확정하지 않았고 실제 연결된 경로에서 P2 다섯 건을 확인했다.

Pro는 첨부 53개 파일의 hash 일치를 확인했다. npm registry DNS 오류 때문에 전체 npm 시험을 직접 재실행하지는 못했다. 조건식·날짜 비교·Node requestTimeout 의미에 대한 보조 재현을 수행했다고 밝혔으며, 제출자의 57/57 통과와 자신의 실행 범위를 구분했다. Pro가 전체 서비스를 실행·검증했다는 뜻이 아니다.

| ID | 지적 | 수정 |
|---|---|---|
| R1 | 특정 규칙 skip이 무관한 산술 실패의 차단까지 해제 | skip의 범위를 해당 검사에 한정하고 전역 차단 해제는 force/warn만 허용 |
| R2 | 연혁 일부 실패가 정상 원문과 성공한 연혁까지 유실 | 원문과 역할별 연혁 상태를 분리하고 부분 결과/전체 deadline 실패를 보존 |
| R3 | 시행일을 UTC 날짜로 비교 | Asia/Seoul 날짜로 비교하고 비교 timezone 명시, 한국 자정 경계 네 시각 시험 |
| R4 | 서버 연결 10초+호출 45초에 비해 bridge 45초가 짧음 | 서버 연결+호출 총 45초, 연결에 쓴 시간을 차감, 정리까지 슬롯 유지, bridge 응답 60초 |
| R5 | upstream의 유의미한 오류 내용/구조화 정보가 API에서 유실 | 예상 도구 오류만 제한된 진단으로 보존, credential/내부 필드/trace 제거 및 크기 제한, REST/MCP 시험 |

추가 보완: SSE 스트림이 열려도 endpoint를 주지 않는 경우 전체 접속 deadline, 공백/줄바꿈까지 포함한 정확한 초안 hash, 게시 tarball의 npm-shrinkwrap과 실제 설치 버전 확인.

## 미완료와 배포 경계

Pro는 조회 전용 HTTPS 전환까지 AGY 완성을 기다릴 필요는 없다고 구분했다. 자동 수리·승인·게시·배포 실행기를 운영 entrypoint에 새로 연결하라는 요구는 없었다. DB 접수를 켜면 실제 migration/권한/복구 시험이 필요하고, 조회 전용 후보에서 접수를 닫는 선택은 허용했다.

운영 HTTPS DNS/터널/외부 3000 폐쇄와 안전한 조회 전용 rollback은 아직 미확인이다. 실제 DB migration/복원 및 전체 자기수정 흐름도 미완료이며 이번 결과로 production GO를 만들지 않는다.

1차 검수 중 GitHub push가 PAT의 workflow scope 부족으로 거부되었다. 실행 workflow를 `deploy/review.workflow.yml.example`로 보존해 나머지를 Draft PR에 게시했다. 원본 검수 입력과 게시 commit의 차이는 이 CI 파일 위치 및 그 사유를 밝힌 문서였고, 당시 runtime/test 코드의 차이는 없었다. **Linux CI는 실행되지 않았다.**

## 2차 검수

- 입력 commit: `4538471b7a7075aed23e97465c2054ef1202cac3`.
- [18개 파일의 수정 패킷](DEPLOYMENT_PRO_PACKET_2026-09-19_v2.md), SHA-256 `a1e36c77b0319f2dcccf7b32c704908103af7f0be8464b0bb3df454a06f72217`.
- 제출 당시 로컬 회귀 시험 64/64, 패키지 검사 6개 통과. 당시 artifact SHA-256 `e9e23ef9cc267cc309affa4fee8cedc6c4318804408579561ef94543d7e98c3d`. 이 artifact는 이후 코드 보완 전 버전이다.
- 7분 2초 처리 후 R1~R3 해소, R4~R5의 기존 직접 반례는 해소됐으나 아래 P2 두 건 잔여로 **CODE REVISE / 운영 HOLD**. 신규 P1 없음.
- Pro는 18개 파일 hash 일치와 합성 SDK/정화 함수 보조 재현을 확인했다. 실제 SDK/자식 프로세스 통합시험과 64개 전체 시험은 Pro 자신의 실행으로 주장하지 않았다.

| ID | 잔여 지적 | 후속 보완 및 재현 |
|---|---|---|
| A (R4) | 짧은 timeout의 요청이 이전 자식 정리 대기 중 만료되면, 슬롯을 먼저 반환하고 대기 작업이 나중에 새 자식을 생성 | 연결 확보 함수에 deadline 전달, 정리 대기 직후 재확인, 연결 확보·정리 종료까지 슬롯 유지. 실제 SDK 자식을 EOF 이후에도 살려 두는 fixture에서 수정 전 실패를 확인하고, 만료된 대기 요청의 슬롯 유지·추가 spawn 없음·새 요청의 정상 재접속을 시험 |
| B (R5) | 숫자형 LAW_OC와 JSON 문자열에 직렬화한 stack/비밀값이 응답에 잔존 | 값 타입에 무관한 credential 키 제거, 알려진 숫자형 비밀값 정화, JSON 문자열을 먼저 파싱한 뒤 동일한 재귀 필터 적용. 구조를 판별할 수 없는 혼합/이스케이프 문자열은 제외. 수정 전 실패와 수정 후 REST/MCP 진단 보존 및 비밀값 제거 시험 |

지원 설치기의 앱 루트 `npm ci`와 버전 일치 검증은 새 차단점으로 판정하지 않았다. 자동 worker 완성을 조회 전용 후보의 선행 조건으로 추가하지 않았다.

## 3차 한정 검수

- 입력 commit: `1fb66e176dba757452899db3fc21a8c5f8ce61dd`.
- [A/B 보완 6개 파일 패킷](DEPLOYMENT_PRO_PACKET_2026-09-20_v3.md), SHA-256 `9dc805d22c89ccce7a3b702f5473c4e33feb283953d3b3e0b15689c5db301191`.
- 제출 당시 로컬 `npm run review` 67/67, package 6개 검사 통과. 당시 artifact SHA-256 `9745e8f086a9d7b90e9985772b90952a321e5e0af17a1864f76d578086e96aea`는 아래 추가 보완 전 버전이다.
- 5분 57초 후 **B 해소, A의 기존 반례 해소 / 경합 P2 A-1 잔여**로 CODE REVISE·운영 HOLD.
- Pro는 패킷 및 6개 파일 hash 일치를 확인했다. 정화 함수 시험 3개를 직접 실행해 통과했고 추가 타입/혼합 문자열/크기 경계를 확인했다. 전체 npm·실제 SDK 통합시험·tgz 재해시는 직접 실행하지 않았다고 명시했다.

**A-1:** 정리 완료 시 이미 만료된 E의 acquisition은 오류를 던지지만, 아직 유효한 N이 그 사이 새 연결을 만들면 E의 catch가 전역 `this.connection`을 선택해 N의 연결을 종료한다. Pro가 실제 클래스와 합성 SDK/transport로 보조 재현했다.

후속 수정은 연결 확보 전 deadline guard를 `LawMcpError(504, MCP_TIMEOUT)`로 구분하여 전역 연결 정리 경로에 들어가지 않게 하는 것이다. 새 회귀시험은 이전 retirement 완료 시점만 제어하고, 새 자식은 실제 SDK/stdio로 기동한다. 이벤트 루프를 잠시 지연시켜 E만 만료되고 N은 유효한 순서를 만든다. 수정 전 N이 MCP_UNAVAILABLE로 실패했고, 수정 후 N이 정상 조회에 성공했다. 기존 슬롯 유지/고아 프로세스 방지 시험도 유지했다.

## 4차 한정 검수

A-1 보완 후 `npm run review` 최종 **68/68 통과**(실패·skip 없음). 첫 전체 실행에서는 별개의 기존 upstream 기동 시험이 10초 deadline으로 실패했다. 코드와 제한값을 바꾸지 않고 해당 시험만 다시 실행해 1.7초에 통과했고, 전체 재실행도 68개 모두 통과했다. 이 일시적 실패의 원인을 확정한 것은 아니며 Linux·운영 cold-start 검증은 여전히 필요하다.

코드 commit·최종 artifact를 고정해 A-1만 재검수하고 최종 독립 판정을 아래에 기록한다. 아직 통과 선언이 아니다.
