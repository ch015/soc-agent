# SOC 데이터 커넥터 — 현재 모듈

문서 기준: 2026-09-23. [코드 연동](embedding.md) · [행동 지침](agent-autonomy.md)

코어 구현은 `src/runtime/investigation/`에 있다. gateway의 기존 adapter 경로는 호환 re-export다. 아래 HTTP 규약 외에도 `dataSource.createConnector(signal)`로 앱의 기존 조회 함수를 직접 전달할 수 있다.

모델은 기존 8개 도구 중 필요한 것만 선택합니다. 도구마다 현재 증거 ID와 조회 이유를 제시해야 하며 같은 조회는 캐시합니다. 사용 가능한 도구는 factory의 `capabilities` 또는 앱 connector의 `capabilities`로 한정합니다. 지원하지 않는 기능은 목록에서 빼면 모델에 제공되지 않습니다.

## nunchi-core

`kind: nunchi-core`는 기존 REST 호출을 그대로 사용합니다.

| 도구 | API |
|---|---|
| get_signal | GET /api/v1/signals/:id |
| get_rule | GET /api/v1/rules/:id |
| get_event_fields | GET /api/v1/events/query-fields |
| search_events | POST /api/v1/events/search/query |
| get_threat_intel | GET /api/v1/threat-intel/indicators?search=...&limit=20 |
| get_identity | GET /api/v1/identities/:id |
| investigate_entity | GET /api/v1/investigate/entity |
| get_entity_graph | POST /api/v1/graph/traverse |

공개 factory의 `dataSource: { kind: 'nunchi-core', baseUrl, token }`으로 추가 분석 서버/인증을 지정합니다. `token`은 앱의 secret 저장소에서 주입합니다. `tokenEnv`는 이전 Kit YAML 전용 설정입니다.

## 다른 SIEM/EDR: http-json

`kind: http-json`을 선택하면 어댑터는 다음 요청을 받습니다. `baseUrl`의 경로 prefix도 유지합니다.

```http
POST <baseUrl>/tools/get_signal
Authorization: Bearer <configured token>
Content-Type: application/json

{
  "version": "1",
  "parameters": {"signalId": "alert-001"},
  "context": {
    "signalId": "alert-001",
    "tenantId": "my-project",
    "timestamp": "2026-09-18T01:00:00Z"
  }
}
```

`reason`/`evidenceIds`는 에이전트의 판단·실행 이력에 남기며 API 요청 매개변수에서 제거합니다. 토큰은 모델 prompt/tool 정의/실행 요청 JSON에 넣지 않습니다. API 인증 주체와 tenant 권한은 **어댑터 서버에서 검증**해야 합니다. `context.tenantId`는 인증 수단이 아닙니다.

| 도구 | parameters |
|---|---|
| get_signal | signalId |
| get_rule | ruleId |
| get_event_fields | {} |
| search_events | query, minutesBefore (1~10080, 기본 30), minutesAfter (0~60, 기본 0), page (1~10, 기본 1), size (1~100, 기본 20) |
| get_threat_intel | indicator |
| get_identity | identityId |
| investigate_entity | entityType, entityValue, period (1h/24h/7d, 기본 24h) |
| get_entity_graph | entityType, entityValue, maxHops (1~3, 기본 1), maxNodes (1~100, 기본 30) |

entityType은 ip/principal/host/resource/service입니다. `search_events`의 시간 기준은 context.timestamp이며 서버 현재 시각이 아닙니다. `get_event_fields` 응답에는 실제 검색 문법·필드·페이지 규칙을 설명해야 합니다. nunchi-core는 NQL, 다른 어댑터는 지원하는 문법을 설명하거나 변환합니다. 가능한 경우 `get_event_fields`와 `search_events`를 함께 제공합니다.

응답은 2xx JSON object입니다. 예: `{"events":[...],"total":12,"hasMore":false,"complete":true}`. 사건 ID, 시각, 출처, 검색 범위, 페이지/잘림 여부를 포함하면 근거를 검토하기 쉽습니다. 도구별 데이터 내용은 분석 API의 사실을 보존해야 합니다. 응답 텍스트는 신뢰할 수 없는 증거로 처리합니다.

- HTTP 오류, `{"error": ...}`, 잘못된 JSON/object, 10초 초과, 1MB 초과는 이용 불가 증거로 기록합니다.
- redirect는 따르지 않습니다. 인증된 목적지 URL을 직접 지정합니다.
- 모델에 주는 관측값은 16,000자를 넘으면 잘림을 표시합니다. 더 좁은 조회가 필요합니다. 응답 최상위 또는 `_meta`의 `complete:false`, `hasMore:true`, `truncated:true`도 부분 증거로 처리하며 정상/기각 판정의 완전한 근거로 사용할 수 없습니다. 다른 API의 페이지 필드는 어댑터에서 이 표기로 변환하세요.
- 빈 결과와 조회 실패를 구분하세요. 실패를 `events: []`로 바꾸면 안 됩니다.
- 악성코드 삭제·계정 차단·티켓 발행 등 쓰기 작업을 이 조회 어댑터에 구현하지 않습니다.
- 모델은 근거 없는 정상 판정을 발행할 수 없으며, 미해결 중요한 질문은 결과에 남깁니다.

상시 SOC worker에서도 `SOC_DATA_CONNECTOR=http-json`, `SOC_TOOL_CAPABILITIES=get_signal,get_event_fields,search_events`로 같은 연결부를 사용합니다.

## 앱 서비스 직접 연결

`createConnector(signal)`은 요청별 `InvestigationConnector`를 반환합니다. 이 인터페이스의 `execute(name, parameters, abortSignal)`에 위 표와 같은 매개변수가 전달됩니다. 앱이 서비스/DB 호출로 변환하고 JSON 업무 증거를 반환합니다. 추가 HTTP 서버가 필요하지 않습니다.

앱이 테넌트 권한과 데이터 범위를 확인하고, 취소 신호를 실제 하위 요청에 전달합니다. HTTP 연결의 redirect/1MB 제한은 내장 HTTP connector 동작이며 사용자 DB connector에 자동 적용되는 보장은 아닙니다. 부분 결과 표시와 실패 의미는 직접 connector도 지켜야 합니다. `get_event_fields`는 검색 문법 정보이며 사건의 직접 증거로 사용하지 않습니다.
