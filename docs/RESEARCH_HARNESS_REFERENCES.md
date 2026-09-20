# OpenTax·korean-tax-agent에서 적용할 구조

현재 구현과 공개 소스를 대조한 결과, 다음 세 가지가 우리 하네스의 빈 부분을 직접 보완한다. 사용자는 우리 서비스도 비상업용이라고 명확히 했다. 따라서 OpenTax 코드를 라이선스 이유로 재사용 후보에서 제외하지 않고, 파일별 고지와 이용 조건을 유지하면서 필요한 부분의 이식을 검토한다. 이 문서는 후속 구현 범위이며, 이번 zisu17 원문 연결 변경에 새 논리 검증 엔진이 들어갔다는 뜻은 아니다.

## 우선순위

| 순서 | 필요한 기능 | 참고 지점 | 현재 우리 코드와의 차이 |
| --- | --- | --- | --- |
| 1 | 실제 조회한 근거와 초안의 인용을 대조 | OpenTax `output_validator.py`의 retrieved_chunk_ids 대조 | `retrievalEnvelope`는 해시를 만들지만 `GateEngine`이 초안의 인용을 실제 조회 기록과 연결하지 않는다. |
| 2 | 쟁점별 요건 → 사실 → 근거 → 효과 연결 | korean-tax-agent `query-analysis.md`, `fact-check.md` | 현재 cues는 필요한 사실을 묻는 용도다. 모든 쟁점의 지지 근거·반대 근거·공백을 표현하는 공통 구조가 없다. |
| 3 | 불명확한 사실·반대 근거가 남으면 결론 상태와 보충 검색을 반환 | korean-tax-agent coverage/unknowns/supplement_search, OpenTax pipeline의 사전 검사 | 현재 needs_info/unverified는 반환하지만, 해당 쟁점에 어떤 자료를 더 찾아야 하는지와 결론 유보를 일반 구조로 연결하지 않는다. |

## 최소 구현안

LLM 선택은 이용자에게 남긴다. 별도 유료 LLM·벡터 DB를 필수로 추가하지 않고, 모델이 구조화한 분석을 MCP가 실제 조회 기록에 대조하는 형태가 맞는다.

1. **조회 영수증 보관.** 성공한 조회마다 서버가 `evidence_id`, 원천 식별자, 내용 해시, 확보한 본문 범위, 시각을 발급한다. 인증 actor에 묶고 만료·메모리 상한을 둔다. LLM이 보낸 `retrieved_ids` 목록을 그대로 신뢰하면 가짜 인용을 막을 수 없다. 공유 API 키는 동일 actor이므로 별도 연구 세션 범위도 필요하다.
2. **쟁점 분석 입력.** 각 쟁점에 요건, 확인된 사실, 미확인 사실, 지지/반대 evidence_id, 연결 논거, 예외·적용시점 검토, 보충 검색을 받는다. 논거는 모델의 해석이며 사실로 승격하지 않는다.
3. **서버가 확인할 수 있는 검사.** 조회하지 않은/만료된/다른 세션의 evidence_id, 본문 없이 요약만 확보한 근거, 필수 쟁점 누락, 제출된 충돌을 무시한 확정 결론, 미확인 사실을 확인된 사실처럼 사용한 선언 등을 검출한다. 인용문을 받으면 보관 원문의 해당 범위와도 대조한다.
4. **확인 범위 분리.** 형식과 근거 식별자가 맞았다는 상태는 `structurally_complete`로 표현할 수 있지만 `legally_verified=true`로 바꾸지 않는다. 근거가 주장을 실제로 지지하는지, 과거/현행 법령 선택과 예외 판단이 맞는지는 모델 분석과 후속 검수가 필요하다.
5. **기존 PR 흐름 연결.** 반박·새 근거로 결론이 수정되면 기존 `prepare_correction_pr`에 공개 가능한 이전/수정 주장과 확인한 원문을 넘긴다. 사용자 미리보기와 동의 뒤 draft PR을 만들고, 기존 사람 머지 절차를 유지한다.

최초 회귀 사례는 “그럴듯한 가짜 문서번호”, “실존하지만 조회하지 않은 인용”, “공유물 분할에 관한 해석례를 분담금 취득원가 배분의 직접 근거로 사용”, “반대 근거와 미확인 사실을 제출하고도 확정 결론으로 표시”가 적절하다. 마지막 두 사례의 의미적 잘못을 문자열만으로 자동 판정할 수 있다고 가정하지 않는다. 쟁점 범위와 근거의 실제 문구를 모델이 명시하고 검수가 대조할 수 있게 만드는 것이 우선이다.

## 그대로 이식하지 않을 부분

- OpenTax의 신뢰도 상한 0.3/0.75 같은 수치와 세목별 강제 결론 변경은 우리 서비스의 법률 정답 판정으로 옮기지 않는다. 이 조사에서 해당 수치의 보정이나 세법 계산 정확성은 검증하지 않았다.
- OpenTax의 전체 RAG·Pinecone·LLM 파이프라인은 “어떤 LLM에서도 사용하는 MCP”의 필수 구성 요소가 아니다. 원천 수집과 구조 검사만으로 시작할 수 있다.
- korean-tax-agent는 Claude Code 중심 스킬이며 단계 분리 지시만으로 서버 측 강제가 생기지는 않는다. 모델별 하위 에이전트 호출법 전체를 가져오기보다 공통 입력/출력 계약을 구현해야 한다.
- 단순히 문서번호가 실존한다고 해서 주장에 맞는 근거이거나 최신 유효 해석이라고 표시하지 않는다.

## 소스와 이용 조건

- [OpenTax output_validator.py](https://github.com/koi2026/opentax/blob/38c49cba2952dea847ba87970bf2800f1855b763/src/domain/output_validator.py), [pipeline.py](https://github.com/koi2026/opentax/blob/38c49cba2952dea847ba87970bf2800f1855b763/src/domain/pipeline.py). 고정 커밋의 라이선스는 PolyForm Noncommercial 1.0.0이다. 사용자 확인에 따라 비상업용 운영을 전제로 재사용 후보에 포함한다. 우선 이식 대상은 실제 검색 ID와 인용 ID를 대조하는 검사다. Python의 TaxAnswer/RAGQueryInput 등 전체 타입·파이프라인 의존성 대신 우리 TypeScript 결과 계약으로 옮기고, 이식 파일의 원 출처와 라이선스를 보존해야 한다. 이번 변경에는 OpenTax 코드를 아직 복사하거나 런타임 의존성으로 추가하지 않았다. 이는 상업용이라고 가정해 배제한 결과가 아니라, 쟁점·근거 영수증 계약을 먼저 정의해야 하기 때문이다. 저장소 전체의 기존 라이선스를 임의로 바꾸지는 않는다.
- [korean-tax-agent query-analysis.md](https://github.com/minsooparkk/korean-tax-agent/blob/6095cdcf1583a2cd513d08f418b65558346a8845/skills/tax/references/query-analysis.md), [fact-check.md](https://github.com/minsooparkk/korean-tax-agent/blob/6095cdcf1583a2cd513d08f418b65558346a8845/skills/tax/references/fact-check.md), [source-search.md](https://github.com/minsooparkk/korean-tax-agent/blob/6095cdcf1583a2cd513d08f418b65558346a8845/skills/tax/references/source-search.md). MIT. 추후 코드·상당한 문구를 복사할 때 저작권과 라이선스 고지를 보존해야 한다.

두 참고 프로젝트는 이번에 설계와 소스를 검토했다. OpenTax 전체 애플리케이션이나 tax-agent의 모델별 에이전트 실행을 검증한 것은 아니다. 직접 실행·통합한 프로젝트는 zisu17/korean-taxlaw-mcp다.
