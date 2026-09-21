# SOC 자율 조사 지침

현재 구현 기준: 2026-09-21. 앱 연결과 취소 사용법은 [코드 연동](embedding.md)을 참조한다.

v2 monitor는 모델이 도구와 종료 시점을 선택하는 `tool_use → tool_result → 다음 판단` 루프다. 고정된 API 수집 묶음, 별도 triage/analyze 호출, 심각도·이벤트 개수에 따른 heuristic 종결을 제거했다. v1 prepared snapshot 경로에는 같은 행동 지침을 추가했고 기존 독립 검토 순서를 유지한다.

## 행동 원칙

1. 현재 판단을 바꿀 수 있는 미해결 질문에만 행동한다.
2. 도구 호출의 `reason`에는 질문과 예상 판단 영향을 짧게 적고, `evidenceIds`에는 이미 관측한 근거를 지정한다.
3. 작은 조회부터 시작한다. 새 엔티티·기간·페이지 탐색은 기존 관측과 연결되어야 한다.
4. 충분한 증거, 유용한 다음 행동 부재, 실행 상한 중 하나에 도달하면 종료한다.
5. API 장애·응답 절단·관측 부족을 안전/정상이라는 근거로 사용하지 않는다.

호스트는 근거 ID의 존재·인자 범위·실행 한도를 검사한다. 사유의 의미적 적절성이나 근거와 결론의 완전한 일치까지 자동 증명하지는 않는다. 이 부분은 모델 행동 지침과 후속 품질 평가의 대상이다.

## 도구 및 한도

모델에는 signal, rule, 검색 필드 metadata, events, TI indicator, identity, entity investigation, graph traversal의 8개 조회 도구를 제공한다. [데이터 연결 규약](data-connectors.md)에 API와 매개변수를 정리했다. 자격 증명과 실제 URL 조립은 호스트가 담당한다. 추가 분석은 nunchi-core의 `/api/v1/investigate/entity`, `/api/v1/graph/traverse`를 사용한다.

- 기본 모델: `claude-haiku-4-5-20251001`; `SOC_LLM_MODEL`로 변경 가능.
- 기본 한도: 모델 8턴, 도구 요청 12회, 전체 120초, 누적 입출력 60,000토큰 확인 후 다음 호출 중단. 한 요청이 토큰 문턱을 넘을 수 있으므로 과금의 절대 상한은 아니다.
- 모델 요청당 30초, 데이터 요청당 10초. 취소 신호를 실제 fetch에 전달한다.
- 동일 턴의 독립 조회를 기본 최대 2개 병렬 실행한다. 증거 ID는 요청 순서로 예약하고, 같은 턴에 아직 보지 않은 결과를 후속 근거로 쓸 수 없다.
- 동일 도구·조회 인자는 재사용한다. 중복 결과는 본문 대신 기존 증거 ID를 전달한다. 사유만 바꿔도 재조회하지 않으며 실패한 동일 조회도 반복하지 않는다.
- 새 성공 관측이 없는 2턴 뒤에는 추가 도구를 중단하고 결론을 요청한다. 빈 성공 응답은 관측으로 기록되므로 서로 다른 빈 조회를 모두 의미적 중복으로 차단하는 것은 아니다.
- API 응답 최대 1MB. 모델에 전달할 관측은 16,000자로 제한하고 절단 여부를 표시한다.
- 그래프 최대 3홉/100노드, 이벤트 페이지 최대 10, 페이지당 최대 100건. 초기값은 더 작게 설정한다.

분석 결과에는 `actions`, `observations`, `evidenceIds`, `unresolved`, `stopReason`, usage를 남긴다. `monitor`는 권고이며 백그라운드 모니터링 예약이 아니다. Slack은 기존 알림 경로로 전달하고 실제 API 성공 응답이 있어야 `notified: true`를 기록한다.

모델 미설정·오류·상한으로 결론을 얻지 못하면 `investigationStatus: incomplete`, `threatLevel: inconclusive`를 반환한다. 큐 작업 처리가 완료되어도 분석 성공으로 표시하지 않는다.

## 검증 범위

로컬 테스트는 관측에 따른 후속 대상 선택, 조기 종료, 중복/실패 조회 재사용, 근거 ID 검증, 예산·취소·한도, API 요청 형식, Slack 전달 결과를 검증한다. 병렬 호출의 순서·취소·동일 턴 중복과 cache 토큰 합계도 검사한다. 모델 응답을 스크립트로 주입한 검사이며 실제 모델의 판정 정확도나 프롬프트 준수율을 측정한 것은 아니다. 기존 `eval:soc`도 prepared snapshot 평가이며 신규 v2 실모델 평가를 대신하지 않는다.

네이티브 도구 메시지 형식은 [Anthropic tool-call 문서](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)를 따른다. 모델 식별자는 [Haiku 4.5 문서](https://platform.claude.com/docs/en/models/haiku-4-5/migration-guide)를 참조했다.
