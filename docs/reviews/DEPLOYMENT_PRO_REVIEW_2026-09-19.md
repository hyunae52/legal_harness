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

## 재검수

R1~R5 수정본의 최종 시험과 정확한 commit을 고정한 후 같은 Pro 대화에 한정 재검수한다. 최종 판정과 artifact digest는 응답 수신 후 아래에 기록한다. 이 문구 자체는 재검수 통과 선언이 아니다.
