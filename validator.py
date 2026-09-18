# validator.py
import yaml
import re

class QualityGateValidator:
    def __init__(self, fail_cases_path="fail-cases.yaml"):
        with open(fail_cases_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)
            self.gates = data.get('gates', [])

    def validate(self, draft_text, context_metadata):
        """
        draft_text: LLM이 작성한 답변 초안
        context_metadata: dict 형태의 메타데이터 (예: {'is_past_event': True, 'owners': 2, 'has_split': True})
        """
        errors = []
        for gate in self.gates:
            if not self._check_trigger(gate['trigger_condition'], context_metadata):
                continue
            
            # Rule Evaluation Logic (Heuristic/LLM-as-a-judge proxy)
            # 실제 구현에서는 이 부분을 가벼운 LLM 프롬프트(LLM-as-a-judge)로 대체하여
            # draft_text가 fail_if 조건을 위반했는지 판별하게 합니다.
            # 여기서는 예시로 정규식 기반 휴리스틱을 구성합니다.
            
            violation_found = self._evaluate_fail_condition(gate['fail_if'], draft_text)
            
            if violation_found:
                errors.append({
                    "gate_id": gate['id'],
                    "error_msg": gate['fail_if'],
                    "correction_prompt": gate['correction_prompt']
                })
                
        if errors:
            return False, errors
        return True, "Pass"

    def _check_trigger(self, condition_str, metadata):
        # Trigger string 파싱 및 메타데이터 대조 로직 (Pseudo)
        # 예: "취득원인 == '이혼 재산분할'" -> metadata.get('cause') == 'divorce'
        # 데모용으로 모두 True 반환하여 검증을 시뮬레이션
        return True

    def _evaluate_fail_condition(self, fail_condition_str, draft_text):
        # 데모용 휴리스틱: 특정 키워드가 초안에 들어있으면 위반으로 간주
        if "그대로 복사" in fail_condition_str and re.search(r"3년 보유", draft_text):
            return True # FC-07 위반 예시
        if "합산" in fail_condition_str and re.search(r"합산하여.*안분", draft_text):
            return True # FC-08 위반 예시
        return False

# 사용 예시
if __name__ == "__main__":
    validator = QualityGateValidator()
    test_draft = "예규에 따라 3년 보유 요건을 채웠으며, A와 B의 원가를 합산하여 안분합니다."
    meta = {"is_past_event": False, "owners": 2}
    
    passed, result = validator.validate(test_draft, meta)
    if not passed:
        print("🛑 Quality Gate 실패! 반려 사유:")
        for r in result:
            print(f"- [{r['gate_id']}] {r['correction_prompt']}")
    else:
        print("✅ Quality Gate 통과")
