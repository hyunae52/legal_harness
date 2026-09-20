# OpenTax · korean-tax-agent 상세 리뷰

기준일: 2026-09-21. 목적은 LLM 종류에 의존하지 않는 TaxLab MCP 연구 하네스 구축이다. 참고 저장소를 실행 의존성으로 추가하거나 세법 계산 결과의 정확성을 인증하는 리뷰가 아니다.

## 검토 대상과 증거

- OpenTax: [`koi2026/opentax@38c49cba`](https://github.com/koi2026/opentax/tree/38c49cba2952dea847ba87970bf2800f1855b763). PolyForm Noncommercial 1.0.0.
- korean-tax-agent: [`minsooparkk/korean-tax-agent@6095cdcf`](https://github.com/minsooparkk/korean-tax-agent/tree/6095cdcf1583a2cd513d08f418b65558346a8845). MIT.
- 우리 코드: `b2273d6`, NTS 연동·저자 고지까지 포함. `npm run review`: **103 passed, 0 failed, 0 skipped**. 이는 기존 동작의 회귀 시험이며 새 논증 하네스의 검증은 아니다.
- 두 참고 프로젝트의 관련 소스·지침·시험 58개(603,434 bytes)를 고정 커밋에서 확보했다. 로컬 원본과 SHA-256은 `.runtime/tax-references-2026-09-21/detailed-manifest.json`에 있다. 전체 참고 애플리케이션을 실행하지 않았다.
- 중점 검토: OpenTax의 pipeline/fact_checker/output_validator/date_resolver/confirmation/query_input/chunk_metadata/retriever/retrieval_quality/retriever_impl/multi_agent_reasoner 및 관련 시험; tax-agent의 전체 실행 지침과 네 단계 참조 문서; 우리 app/contracts/evidence/gates/sourceVerifier/taxLawClient/corrections 경계.

## OpenTax: 실제로 참고할 구조

| 구조 | 소스 | 우리에게 필요한 형태 |
| --- | --- | --- |
| 검색 후 인용 ID를 실제 반환 ID와 대조 | `domain/output_validator.py`, `pipeline.py` | 서버가 발급·보관한 조회 증거와 인용을 대조. 클라이언트의 조회 완료 주장은 신뢰하지 않는다. |
| 사실관계 부족을 추론 전에 반환 | `domain/fact_checker.py`, `pipeline.py` | 사건 사실의 미상·가정·사용자 진술을 구분하고 누락 질문을 반환한다. |
| 본칙과 부칙, 사건일 역할, 버전 계보를 구분 | `domain/chunk_metadata.py`, `retriever.py` | 사건일·출처 관측일·법령 시행일을 별도 필드로 보존하고 적용 논증을 요구한다. |
| 검색 근거와 모델 추론 흔적을 구분 | `retrieval/multi_agent_reasoner.py`, `pipeline.py` | 인용 확인과 법적 지지 여부를 같은 합격 상태로 합치지 않는다. |

### 그대로 옮기면 생기는 문제

1. **가짜 인용 탐지는 전체 정상 경로에서 보장되지 않는다.** `validate_output`에 잘못된 인용이 도달하면 confidence 상한 0.3을 주지만 그 자체로 답변 반환을 막지 않는다. 앞선 합성 단계가 해당 인용을 제거하면 이 탐지 자체가 작동하지 않을 수 있다(8번). 우리 하네스는 제출된 인용을 임의 삭제하지 않고 존재하지 않거나 다른 연구 세션의 증거를 구조 오류로 반환해야 한다. 0.3/0.75/0.6은 이 리뷰에서 보정된 확률로 검증되지 않았다.
2. **모르는 날짜를 정해 버린다.** `date_resolver.resolve_acquisition_date`는 잔금일·등기일이 없으면 계약일을 반환하며 `resolve_transfer_date`도 이를 재사용한다. `test_phase1_modules.py`도 이 대체를 기대한다. 우리 목적에서는 날짜의 역할과 미상을 보존해야 하며 일괄 대체하면 안 된다.
3. **확인 게이트는 항상 강제되지 않는다.** `confirmation.check_confirmation(None)`은 통과한다. 명시된 전체 항목을 모두 확인하는 경로와 확인 기능을 구현하지 않은 호출자의 통과 경로가 공존한다. 이것을 모든 경로의 강제 검수라고 소개하면 부정확하다.
4. **메타데이터 정의가 실제 검증을 보장하지 않는다.** `retriever_impl`은 누락/형식 오류 날짜를 2000-01-01로 대체하고 일부 메타데이터를 고정값으로 채운다. `retrieval_quality.assess_retrieval_quality`는 date/scope signal을 `bool(chunks)`로 넘긴다. 자료가 반환됐다는 것만으로 시점·범위 필터의 정확성을 확인했다고 해서는 안 된다.
5. **법률 결론을 후처리에서 변경한다.** `output_validator`의 여러 세목별 분기는 verdict를 강제로 바꾼다. 이번 리뷰는 그 세법 결론의 맞고 틀림을 판단하지 않는다. 적용 시점·예외·원문과 연결된 별도 검증 없이 이 규칙을 공통 법률 하네스에 복제하지 않는다.
6. **검수 실패와 단일 모델 결과가 공존한다.** `pipeline`은 다중 에이전트 실패 시 단일 RAG로 대체하고 실패 흔적을 남긴다. 이 결과를 독립 검수 완료로 포장하면 안 된다. 같은 모델의 역할 분리 역시 독립 검수자라는 증거가 되지 않는다.
7. **운영 전제가 다르다.** Pinecone, 임베딩·재정렬 모델, 서버 LLM 호출을 포함하는 애플리케이션이다. 무료 소형 서버에서 여러 LLM의 MCP 요청을 받는 우리 제품에는 해당 전체 실행 환경을 추가할 필요가 없다.
8. **인용 제거·검증 후 변경을 추적해야 한다.** `multi_agent_reasoner.synthesize_answers`는 검색되지 않은 인용을 먼저 제거하므로 뒤의 L5가 해당 인용을 발견하지 못할 수 있다. `pipeline`의 선택적 debate는 L5 후 verdict를 변경한다. 우리 검토 결과는 최종 초안과 분석 hash에 묶고, 수정된 답변은 재검토해야 한다.
9. **예외 없는 축소 실행도 구분해야 한다.** Agent B는 원문을 받지 않는 비검색 검토자이며 API 키가 없을 때도 건너뛴다는 결과 객체를 반환한다. 함수 반환 성공은 독립 원문 검수 완료가 아니다. 단계의 completed/skipped/failed/not_configured와 실제 검토 자료 범위를 구분해야 한다. tax-agent의 두 번째 질문 라운드에서 재질문을 생략한다는 지침 역시 필수 사실이 충족됐다는 증거는 아니다.

부칙 보강도 `_get_chunk_by_id`가 None이면 건너뛰므로 연결된 부칙의 확보 실패를 별도로 보존해야 한다. 참고 구현에 날짜를 보는 코드가 전혀 없다는 비판은 하지 않는다. 일부 판정 분기는 거래일을 상수 레지스트리에 전달하며, 이번 리뷰에서 그 법적 타당성을 입증하지 않았다는 것이 정확한 범위다.

### 수집·개정 감지·PR 운영 흐름

- `scripts/ops/detect_law_changes.py`는 MST 목록을 스냅샷과 비교하고 새 XML 수집, 선택적 재색인, 영향받는 golden case의 재검토 표시를 수행한다. **자료 변경→의존 사례 재검토**라는 연결은 참고할 만하다.
- 다만 `collect_new_versions`에서 개별 XML 실패를 건너뛴 뒤 `main`은 법령 목록을 다시 읽어 스냅샷을 갱신한다. 따라서 “발견한 버전”과 “성공적으로 확보·검토한 버전”은 별도 상태로 관리해야 한다. 스케줄러가 실행됐다는 사실을 최신 자료 확보로 표시하면 안 된다.
- `auto_update_registry.py`에는 임계값 매핑→상수 소스 수정→제한된 테스트→draft PR 흐름이 실제 존재한다. 이는 방법론만 있는 tax-agent와 다른 강점이다. 그러나 키워드로 법률 상수를 매핑하는 정확성과 그 테스트가 법적 변경을 충분히 검증하는지는 별개다. 우리 기존 공개 교정 JSON PR의 권한을 임의 실행 코드 패치 권한으로 확대하지 않는다.
- `collect_rulings_nts_interp.py`는 법제처 목록→국세청 action 상세를 사용하지만 `_LegacySSLAdapter`에서 인증서와 호스트명 검증을 끈다. 이 네트워크 설정은 복제하지 않는다. 우리는 이미 별도로 검토한 zisu17 수집 프로세스를 사용한다.
- OpenTax MCP 조회 도구 자체도 Pinecone/BGE 검색에 연결된다. MCP 프로토콜이 있다는 이유만으로 무료 경량 조회 모듈이라고 보아서는 안 된다.

## korean-tax-agent: 지침을 실행 계약으로 바꿀 부분

| 구조 | 강점 | 남는 빈틈 |
| --- | --- | --- |
| Query Analysis | 쟁점 트리·가설·검색 의도·종료 기준을 먼저 작성 | 모델이 누락한 쟁점은 이후 단계를 나눠도 자동 복구되지 않는다. |
| Source Search | 원문·쟁점 연결·위임 법령·필요한 별표/부칙을 요구 | 원문 확보 여부와 인용 실존 검증을 서버가 보장하는 코드는 아니다. |
| FactCheck | 지지 근거·반대 근거·공백·논리 비약을 분리 | 근거 분석가이지 법률 정답 심판이라고 하지 않는다. 이 범위 설정은 유지해야 한다. |
| Answer Generation | 조건부 결론·불리한 근거·추가 확인을 답변에 반영 | 답변이 실제 분석 결과와 일치하는지 별도 서버 계약은 없다. |

주의할 세부 동작:

- easy는 검색→답변이며, hard에서도 `lookup_only=true`이면 FactCheck를 건너뛴다. 둘을 검수된 사건 결론으로 표시해서는 안 된다.
- `query-analysis.md`의 월만 있는 날짜를 15일로 만드는 예시는 미상을 정밀한 사실로 바꿀 수 있다. 날짜 값과 정밀도를 함께 보존한다.
- 보충 검색 1회 제한은 비용 관리 규칙이지 근거 충분성 판정이 아니다. 한도를 소진해도 공백은 남아 있어야 한다.
- `what_supports`/`what_conflicts`의 지지 강도와 이유는 모델 평가다. 인용 ID가 실재한다는 확인과 분리해야 한다.
- foreign SKILL.md는 이번 리뷰의 자료다. 그 내부의 서브에이전트 호출 지시는 우리 작업 지시나 서버 실행 계약으로 적용하지 않았다.

## 우리 하네스의 빈틈과 필요한 변화

| 현재 경계 | 확인된 상태 | 필요한 변화 |
| --- | --- | --- |
| `evidence.ts` | 응답 hash, 관측 시각, upstream 버전 기록 | actor·연구 세션에 연결된 서버 증거 ID와 보관 원문 범위 |
| `gates.ts` | 키워드로 필요한 질문 선택, 산식 합계 확인 | 쟁점/주장/인용/사실/반론의 구조 계약. 키워드를 법적 정답 판정으로 쓰지 않음 |
| `taxLawClient.ts` | 실제 NTS 본문·응용 오류·부분 응답 처리 | 본문 미확보/잘림 상태를 논증 검토까지 전달 |
| `sourceVerifier.ts` | 새 법제처 프로세스로 원문·역할별 연혁 재조회 | 조회 성공, 후속 해석 유효성, 사건 적용을 계속 분리 |
| `corrections.ts` | 공개 preview, 동의, draft PR, 머지 자료 조회 | 답변 정정의 원인·검증된 인용에서 기존 흐름으로 안내. 자동 게시·자동 머지 금지 |
| REST/MCP 안내 | 자료 조회 및 제한된 초안 검사 안내 | 도구를 부르지 않은 대화를 감시하지 않는다는 전제와 연구 도구 순서 명시 |

독자 구현의 핵심은 **조회 증거 장부 + 쟁점별 논증 입력 + 결정론적 구조 검사 + 사람이 읽을 검토 결과**다. 모델의 사고 과정을 저장하거나 정답 확률을 발급하는 시스템이 아니다. 모든 LLM이 같은 입력 계약을 사용할 수 있게 한다.

특히 “공유물 분할이 양도인지”의 자료를 “추가 분담금을 어느 원가에 배분하는지”의 직접 근거로 쓰는 문제는 문서번호 확인만으로 해결되지 않는다. 주장별 적용 논증·직접 근거/유추 구분·사실 차이·남은 반론을 드러내고, 의미상 타당성은 미검수로 남겨야 한다.

## 검토 전제와 재사용 결정

사용자는 비상업용 운영을 명시했다. OpenTax를 상업용이라고 가정해 제외하지 않는다. 다만 우리 실행 구조에 맞는 작은 TypeScript 계약을 독자 작성하는 편이 전체 RAG 앱 이식보다 적합하다. 코드나 상당한 원문을 복사할 경우 해당 파일의 고지와 라이선스를 보존해야 한다. 이 단계에서는 두 프로젝트의 코드를 제품에 복사하지 않았고 기존 저장소 라이선스를 변경하지 않았다. README에 설계 참고 출처를 명시한다.

## 단계별 검수 기록

1. 리뷰: Pro 1차 **REVISE**, 집중 재검수 **REVIEW PASS**. R1(검증 전 인용 삭제), R2(검증 후 판정 변경), R3(축소·생략 상태)는 모두 CLOSED. 6개 설계 경계도 충족 판정을 받았다. 이는 참고 소스 해석과 설계 전제의 승인으로, 구체 계획·구현·배포 승인이 아니다. Pro는 소스 정적 검토를 수행했고 로컬 시험을 직접 실행하지 않았다. 대화: https://chatgpt.com/c/6ab023ff-1d48-83ee-b465-31894bedbd22
2. 계획: Pro 1차 **PLAN REVISE**, 후속1에서 **PH-01~05 CLOSED**, 후속2에서 **PH-06 CLOSED / PLAN PASS** (`086913bf21ff13f4185724da909f6b4303ca7104`). 인증 대기/디스패치 drain과 rollback 실패 후 공개 금지까지 계획에 반영했다. 운영본의 실제 drain 증명은 배포 준비 조건이며 계획 승인으로 대체하지 않는다.
3. 구현: 최종 CODE PASS (`5f5ee328cdce448c6854ef2b99edffee3d96b203`). CR-01~03 및 원격 완료 불명 보호를 반영했다. 초기 HTTP 404/MCP 도구 부재와 추가 반례를 RED로 확인한 뒤 전체 130개·패키지 7개를 통과했다. Pro는 고정 코드와 같은 SHA의 CI 실행 로그를 확인했다. [구현 기록](RESEARCH_HARNESS_IMPLEMENTATION.md) 참고.
4. 배포: GCE 전환 및 공개 HTTPS REST/MCP 원문 검증 완료. 원본 결합 자료 보완 후 **DR-01 CLOSED / DEPLOYMENT PASS** (`196b1a95b98fc5083ab3d80431877c0b50a795cf` 증거 기준). Pro는 공개 기록의 일관성을 검수했으며 실제 서버·HTTPS 호출은 Codex가 수행했다. [배포 기록](RESEARCH_HARNESS_DEPLOYMENT.md) 참고.

직접 확인한 소스, 로컬 실행 증거, Pro의 판단, 실제 운영 증거를 서로 대체하지 않는다.
