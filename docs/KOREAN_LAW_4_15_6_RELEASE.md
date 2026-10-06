# korean-law-mcp 4.15.6 적용

법령 엔진을 공식 npm `korean-law-mcp@4.15.5`에서 `4.15.6`으로 올린다. `package.json`, `npm-shrinkwrap.json`, `package-lock.json`을 함께 고정한다. 별표 파서는 기존 `kordoc@4.18.2`다.

배포 전 보안 검사에서 발견된 [proxy-addr 취약점](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)을 해결하기 위해 간접 의존성도 `2.0.7`에서 수정 버전 `2.0.8`로 고정한다. 외부 IPv4 접속자가 짧은 IPv6 신뢰 범위를 악용해 전달 IP를 위조하지 못하는지 회귀시험을 추가했다. 그 밖의 의존성은 유지한다.

[공식 릴리스](https://github.com/chrisryugj/korean-law-mcp/releases/tag/v4.15.6)의 주요 변경은 판례 제목·본문 동시 검색과 문자열 본문검색 옵션 수정이다. 공개 MCP의 다음 호출로 사용할 수 있다.

```json
{
  "name": "search_decisions",
  "arguments": {
    "domain": "precedent",
    "query": "학원강사 근로자",
    "options": { "search": "both" }
  }
}
```

두 검색 결과를 판례 ID로 중복 제거하고 각 결과의 적중 범위를 표시한다. 기존 기본값과 사건번호 정확 검색은 유지된다. 원작자가 제공하는 도구 설명과 옵션이 기존 stdio 연결을 통해 공개 MCP에도 전달된다.

세법 엔진은 검토 포크 `hyunae52/korean-taxlaw-mcp`의 `2.1.0.post1` / `16a08b9af70f49fc60a5f54ab0f9812be206c8f5`를 유지한다. 2026-10-07 KST 확인 시 원작자 main은 이미 반영한 `a91872fed2c12cd51fffdc4c2dbbfcabe997262b`이며, 포크의 추가 변경은 버전 기록·검증·문서다.

## 검증과 전환

기존 사건번호·판결 전문·사건일 법령·개명 법령 연혁·별표·표·수식 검증에 다음 실조회 두 건을 추가했다.

- `options.search="both"`: 제목·본문 검색의 결과와 중복 없는 판례 ID 확인
- `options.search="2"`: 문자열 옵션으로도 본문검색이 실행되는지 확인

후보의 로컬 회귀·패키지 검사와 GCE 독립 후보의 10개 실조회 결과는 [검증 기록](evidence/korean-law-4.15.6-preflight-20261007.json)에 저장한다. 실제 모델 평가나 개별 사건의 법률적 결론을 검증한 기록은 아니다.

정확한 후보의 GitHub Review 성공 후 기존 rollout gate로 유입 차단, 진행 요청 종료 대기, 제공자 선택 전환, 실제 MCP 검사, 유입 재개를 수행한다. 이전 4.15.5 설치와 설정은 보존한다. 자동 배포기의 제공자 보호 기준과 manifest 해시를 함께 갱신한 뒤 main Review·자동 Deploy와 공개 HTTPS 조회를 확인한다. 최종 배포 여부는 해당 PR의 Actions와 운영 확인 기록으로 확정한다.

매일 03:30 KST의 upstream 감시 일정은 유지한다. 적용 후에는 메일을 보내지 않는 감시 명령으로 최신 버전 인식을 확인한다.

후보 설치 전 가득 찬 디스크는 사용이 끝난 회전 로그 두 개를 무손실 압축해 약 774 MiB를 확보했다. 압축 전과 해제 후 SHA-256이 같고 두 파일이 프로세스에서 열려 있지 않은 것을 확인했다. 활성 로그·현재 서비스·이전 릴리스는 보존했으며, 지속적인 로그 증가에 대한 보관 정책 변경은 이 패키지 업데이트에 포함하지 않는다.
