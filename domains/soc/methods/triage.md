# Triage Method Card

## 목적
시그널을 60초 이내에 분류하여 심층 분석 여부를 결정한다.

## 절차

1. **시그널 확인** — `get_signal`로 시그널 상세를 가져온다
2. **룰 확인** — `get_rule`로 탐지 룰의 카테고리와 정밀도를 확인한다
3. **TI 대조** — subject(IP/domain/hash)를 `get_threat_intel`로 조회한다
4. **최근 이벤트** — `search_events`로 동일 subject의 최근 5분 이벤트를 최대 20건 가져온다
5. **판정** — escalate / monitor / dismiss 중 하나를 결정하고 JSON을 반환한다

## 판정 로직

```
IF (severity == critical OR high) AND (ti_match OR multi_signal):
  → escalate, priority = severity
ELIF (severity == medium) AND (unusual_pattern OR ti_match):
  → escalate, priority = medium
ELIF (severity == low OR info) AND (no_ti_match) AND (single_event):
  → dismiss OR monitor
ELSE:
  → monitor
```

## 금지 사항

- 5건 이상의 API 호출을 하지 않는다
- 심층 분석(entity graph, investigation session)을 시작하지 않는다
- `blocked` 상태를 반환하지 않는다
- 60초를 초과하지 않는다
