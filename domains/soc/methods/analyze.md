# Analyze Method Card

## 목적
escalate된 시그널에 대해 심층 분석을 수행하고 슬랙 알림용 구조화 결과를 생성한다.

## 절차

1. **triage 결과 읽기** — `01_triage_result.json`에서 context와 판단 근거를 확인한다
2. **이벤트 확장 검색** — triage에서 확인한 시간 범위를 전후로 확장하여 관련 이벤트를 수집한다 (최대 100건)
3. **entity 조사** — `investigate_entity`와 `get_entity_graph`로 subject의 연관 관계를 파악한다
4. **identity 확인** — 사용자 관련 시그널이면 `get_identity`로 계정 정보를 확인한다
5. **타임라인 구성** — 이벤트를 시간순으로 정렬하여 공격 흐름을 재구성한다
6. **위협 판정** — confirmed-threat / likely-threat / suspicious / benign / inconclusive 중 결정한다
7. **권고 생성** — 즉시 조치, 단기 권고, 모니터링 포인트를 작성한다
8. **JSON 반환** — 분석 결과 스키마에 맞춰 반환한다

## 분석 깊이 가이드

| triage priority | 분석 깊이 | 최대 API 호출 | 목표 시간 |
|-----------------|----------|--------------|----------|
| critical | full (graph + TI + identity + events) | 15 | 3분 |
| high | standard (events + TI + identity) | 10 | 3분 |
| medium | light (events + TI) | 7 | 2분 |

## 금지 사항

- `blocked` 상태를 반환하지 않는다
- 운영 action을 실행하지 않는다 (차단, 격리, 케이스 생성 등)
- 5분을 초과하지 않는다
- 증거 없이 "침해 확정"을 선언하지 않는다
- 대응 자동화를 시도하지 않는다 — 권고만 생성한다
