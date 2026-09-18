# SOC 도메인

현재 구현 기준: 2026-09-18. 실행·배포는 [프로젝트 README](../../README.md), 앱 연결은 [embedding](../../docs/embedding.md)을 따른다.

- v2: 모델의 조회 도구 선택 → 관측 → 후속 조사 또는 종료. 고정 heuristic/triage/analyze 파이프라인을 대체했다.
- v1 report: evidence-review → judge → verify.
- v1 investigation: evidence-review → analyze → verify.

v2의 실행 정본은 `src/runtime/investigation/`의 조사 루프·도구·정책이다. nunchi-core 엔티티 조사와 그래프 조회를 포함한 8개 읽기 도구, HTTP connector, 앱의 직접 connector를 지원한다. gateway의 기존 adapter 경로는 호환 re-export다. [데이터 연결 규약](../../docs/data-connectors.md)을 참조한다.

v1은 서명된 snapshot과 정확한 파일 허용 목록을 읽고 호스트가 내부 draft를 생성한다. v1 계약은 `contracts/`, 역할은 `agents/`, 실행 카드는 `methods/`에 있다. 기존 triage/monitor agent 및 triage/analyze method 파일은 호환 자산이며 현재 v2 루프가 그 순서를 자동 실행하지 않는다.

모델 실패·상한 내 결론 부재는 incomplete/inconclusive로 남긴다. 개별 조회 실패는 이용 불가 근거로 기록하며 다른 충분한 증거로 판정할 수 있으면 완료할 수 있다. `monitor`는 권고이며 백그라운드 예약이 아니다. 앱 호출의 알림/결과 저장은 호출 앱이 담당하고 기존 worker의 Slack 전달은 실제 응답으로 성공 여부를 기록한다.

플러그인 이름 `nunchi-soc`과 `nunchi.soc.*` 계약 ID는 입력 호환성을 위해 유지한다.
