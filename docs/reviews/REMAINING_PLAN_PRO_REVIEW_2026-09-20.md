# 남은 구현·운영 전환 계획 — 별도 Pro 검수 기록

대상: [남은 계획](../REMAINING_PLAN_2026-09-20.md). UI 모델 표시는 **6 Pro**, 검수는 [별도 ChatGPT 대화](https://chatgpt.com/c/6aae9b76-b7d8-83e8-b743-71f206c6b9dd)에서 수행했다. 구현자가 자기 결과를 독립 검수라고 표시하거나 AGY/일반 sub-agent를 Pro로 대신하지 않았다.

기존 실행 코드의 마지막 응답을 다시 읽은 뒤 남은 계획을 새로 작성했다. 기존 `e7ce0b2214c94dae1f3f2e96281b045635ddb4c5`의 **조회 전용 제한 후보 CODE PASS / 운영 HOLD**와 이번 계획 판정은 별개다.

## 제출 자료와 판정

| 회차 | 제출물 | SHA-256 | 실제 응답 |
|---|---|---|---|
| 1 | [계획 v1 패킷](REMAINING_PLAN_PRO_PACKET_2026-09-20_v1.md) | `7b8a23b2adb3134649ab5e99df859567dce0db269866858868b1c93097bd98d4` | **PLAN PASS / 운영 HOLD 유지**, 처리 9분 29초 |
| 2 | [권고 반영 v2 패킷](REMAINING_PLAN_PRO_PACKET_2026-09-20_v2.md) | `11058ed95f723295a26cd30c623c06c656a1fdf79131de850e34d38b885d450b` | **PLAN PASS / 운영 HOLD 유지**, 변경분 한정 재확인, 처리 2분 15초 |

v2 제출 본문 SHA-256: `06d9deb2a4f4c81c38002fe8ae62f7ae84af89445b227b9bcbf45f211b0895d4`. 패킷은 덮어쓰지 않으며 과거 코드 검수 패킷도 그대로 보존한다. 수신 후 최신 계획의 상태 한 줄만 최종 판정·이 기록 링크로 갱신했고, 실행 계획 본문은 제출본과 동일하다.

## 1차에서 확인한 결과

Pro는 계획을 막는 확정된 누락·모순이나 승인 순환을 확인하지 않았다고 판정했다. 조회 전용 HTTPS 중간 전환 A와 실제 자기수정까지 포함한 B의 분리가 적절하며, A가 먼저 완료돼도 B 완료 조건을 유지해야 한다는 결론이다.

Pro가 직접 확인한 범위는 패킷/포함 문서 3개의 hash, 계획 전체와 직전 검수의 정합성, GitHub CI 시작 조건·Supabase 백업 관련 공식 문서다. runtime 변경 없음, PR 상태, 실제 HTTPS/HTTP 관찰, Windows 68개·package 6개 시험은 구현자의 관찰로 구분했다. Pro가 서버·DB에 접속하거나 전체 시험을 재실행했다고 주장하지 않는다.

최종 답변에서 **필수 계획 수정은 없음**이라고 명시했다. 중간 진행 메시지에서 실행 취소·DB 복원 경계의 보완 필요성을 언급했지만, 최종 판정에서는 이미 계획에 있는 안전 조건을 구체적인 실패 주입 시험으로 명시하라는 개선 권고로 정리했다. 이를 새 P1/P2 코드 결함이나 PLAN REVISE로 기록하지 않는다.

## 권고 반영

| 권고 | v2 반영 | 구현에서 요구할 증거 |
|---|---|---|
| A의 최소 배포 경로와 B4 의존성 구분 | A2에서 고정된 build/배포/복구 명령을 완성, B4에서 재사용·확장 | 다른 artifact/설정/tree의 공개 전환 전 거부, 실패 복구 |
| CI 첫 실행과 시험 식별자 | 같은 PR branch의 소유자 push → PR synchronize. workflow/run/attempt/event/실제 checkout commit/tree/artifact 분리 | provider 증거와 실제 시험/승인 대상 일치 |
| 복원·응답 유실 경계 | remote 수락 후 응답 유실/lease 교체, DB intent 행 자체 소실, fixture/집계 변조 시나리오 | 오래된 결과 승인 금지, 원격 종료 불명시 슬롯 유지, 예산 보수 계상, 외부 namespace 대조/불명 HOLD |
| 무료 운영 합산 자원·백업 | 전환 중 구형+후보+tunnel, 조회+coordinator 합산. export 예약/별도 보관/키 복구. lease와 작업/runner deadline 구분 | 실제 상한 충족과 격리 복원, 사용 중인 Storage만 별도 범위 |

추가 명확화: A의 조회 배포는 사람이 검수한 운영자/Codex 명령으로 실행 가능하며 현재 `release:verify`의 `deployment_authorized:false`를 GO로 해석하지 않는다. DNS/tunnel 실패로 외부 503이 미관찰이면 복구 미확인 상태로 기록한다. AI verdict 명칭은 실제 `ReviewVerdictSchema`의 `approved / changes_requested / needs_evidence / unavailable`와 통일했다.

## 2차 최종 판정

Pro는 v1/v2를 직접 대조하여 패킷·본문 hash 일치와 동봉된 기존 manifest/검수 기록의 무변경을 확인했다. **권고 4개 모두 반영, 새 차단점·모순 없음, 잔여 필수 수정 없음, PLAN PASS**가 최종 판정이다.

A2에서 최소 실행 경로를 시험하므로 B4의 자동 배포기를 기다리는 순환이 없고, CI 경로 지정도 성공 보장으로 바뀌지 않았다고 확인했다. 외부 상태 불명 시 슬롯·예산 유지/보류, DB에서 없어진 intent의 외부 대조, 실제 fixture·집계 변조 시험도 반영됐다는 결과다. 총 45분·runner 15분은 상한이고 최대 시도 3회를 반드시 모두 실행할 의무가 아니므로 모순이 없다고 보았다. 503 미관찰의 미확인 기록과 정확한 verdict enum도 승인 조건을 완화하지 않는다고 확인했다.

계획 검수 범위는 문서 hash·차이·정합성이다. 실제 Linux CI·운영 기동·HTTPS·3000 폐쇄·복구·마지막 사람 검수 증거를 대신하지 않으며, 기존 코드 CODE PASS / 운영 HOLD와 A·B의 완료 경계는 유지된다.

## 이번 작업에서 수행한 확인과 범위

- PR #3은 계획 작성 전 provider API에서 open/draft/미머지, HEAD `449f7f01fe7f2999e2ad4a41dfcb9096fe0730fb`로 확인했다.
- 2026-09-20 03:24 UTC: 자격증명 없는 HTTPS health는 ENOTFOUND, 기존 공개 HTTP 3000 health는 200. 조회 관찰만 수행했다.
- 검수 코드 이후 runtime/scripts/tests/rules/deploy/의존성/SQL/프로세스 설정의 diff 없음. 문서만 바꾸므로 68개/6개 시험을 다시 실행했다고 기록하지 않는다.
- 기존 로컬 tarball을 다시 SHA-256 계산하여 `08fe3e6d24a22d1d68e4db278b29d43d96f627339999a897423114b0a2cf7f61` 일치 확인. 이번 문서 변경으로 새 Linux artifact를 만들거나 검증한 것은 아니다.
- 각 새 패킷은 공개 문서 allowlist로 만들고 알려진 credential 값·private case 표식을 검사했다. 원본 사건 파일과 `.env`는 첨부하지 않았다.
- 계획·검수 문서와 README의 내부 링크 및 diff 공백을 확인했다. 게시할 계획은 검수한 v2와 상태 한 줄을 제외한 본문이 동일함을 hash/문자열 비교로 확인했다. 최종 계획 파일 SHA-256은 `da8cc19fcd1fee3ce1cd2f4751a7a5699022d4cdb9f0cc30db9a32be3188409b`다. 기존 구현 계획은 역사 기록임을 표시하고 최신 남은 계획으로 연결한다.

머지·배포·DB migration·새 CI/cron 등록·worker 활성화는 이번 계획 작업에서 하지 않았다. 운영 HOLD를 없애는 증거는 A/B의 해당 구현·운영 단계에서 별도로 확보해야 한다.
