# SOC 개발 현황

기준: 2026-09-22. [프로젝트 README](../README.md) · [문서 목록](README.md)

## 구현된 기능

| 경로 | 현재 동작 |
|---|---|
| 공개 코드 API | `createSocAgent()`에 모델·HTTP 또는 앱 connector를 주입. Node.js 22.18 이상 ESM, 필수 의존성 Zod |
| v2 조사 | signal → 모델의 읽기 도구 선택 → 관측 → 후속 조사 또는 종료. `completed`/`incomplete`와 근거·usage 반환 |
| v1 | 서명된 prepared snapshot의 report/investigation, 독립 검증 후 내부 draft 또는 hold |
| 데이터 조회 | signal/rule/fields/events/TI/identity/entity/graph의 8개 읽기 도구 |
| 조사 제어 | 기본 8턴·12도구 요청·120초·60,000토큰. 독립 조회 기본 2개 병렬, 중복 재사용, 시간 초과·취소 처리 |
| 서비스 | gateway·PostgreSQL·Redis·worker·Compose, 테넌트 인증·할당량·지속되는 중복 판정, escalation Slack 전달 |
| 정책 참고 | 내부 조사·판정·v1 계약 지침. MITRE 전술 문자열 출력. 외부 정책 문서 RAG는 미연결 |

실행 옵션과 모델·connector의 책임은 [코드 연동](embedding.md), API 형식과 데이터 한도는
[데이터 규약](data-connectors.md), 정책 목록과 향후 요청은 [정책 문서 안내](policy-documents.ko.md)를 따른다.

## 2026-09-22 검수 반영

- 클래스 connector의 메서드·상태를 보존하고 실행 한도를 검증한다. 앱이 제공한 모델/connector가
  취소에 응답하지 않아도 호스트는 제한 시간에 반환하며 늦은 결과를 수락하지 않는다.
- 잘못된 JSON·job UUID·페이지 수치를 400으로 처리하고 terminal/waiting job의 오래된 큐 전달을 건너뛴다.
- signal ingress와 일반 jobs 요청에 같은 PostgreSQL 테넌트 행 잠금을 적용한다.
  중복 확인·할당량·job 생성을 원자적으로 처리해 동시 중복 생성과 signal 할당량 우회를 수정했다.
- generic `options.dedupKey`의 중첩 JSON 경로를 수정했다. DB 커밋 후에만 큐로 전달하고,
  Redis 실패는 503으로 노출하며 동일 식별자 재시도로 기존 queued job의 전달을 복구한다.

이 변경의 DB migration은 필요하지 않다. 모든 gateway를 새 admission 코드로 전환해야 같은 잠금
규약을 따른다. 운영 배포를 수행했다는 의미는 아니다. [서비스 API와 재시도 조건](service-api.ko.md)을 확인한다.

## 검증 기록과 남은 범위

2026-09-22 후속 검수에서 타입·계약·고정 fixture 평가·서비스 빌드를 통과했다.
일반 테스트 359개와 별도 임시 PostgreSQL 테스트 22개, 두 gateway 및 실제 Redis·worker를 사용한
서비스 assertion 26개를 통과했다. 서로 다른 실행의 수치를 중복 합산하지 않는다.
회귀 근거는 [admission 통합](../src/gateway/__tests__/admission.integration.test.ts),
[큐 전달](../src/gateway/__tests__/admission-delivery.test.ts),
[조사 루프](../src/gateway/__tests__/soc-agent-loop.test.ts)에 있다.

실모델의 판정 정확도·운영 SIEM 의미 매핑·실제 Slack 전달·전체 응답 시간은 별도 환경에서 검증해야 한다.
`eval:soc`은 prepared snapshot 고정 평가이며 v2 실모델 품질 평가가 아니다.
job `completed`만으로 조사 성공을 판단하지 않고 `result.investigationStatus`, `phase`, `llmUsed`, `notified`를 확인한다.
`monitor`는 권고이고 재조사 예약이 아니다. 기본 v2에 자동 차단·격리·정책 RAG·벡터 DB는 연결되지 않았다.
호출자의 재시도 없이 미전달 job을 자동 재전송하는 outbox도 제공하지 않는다.

## 문서 관리

현재 안내는 README, 이 문서, embedding/data-connectors/agent-autonomy/service-api/policy-documents다.
번호가 붙은 과거 설계·포팅 기록의 완료 표시와 테스트 수는 당시 기준으로 보존한다.
계약에 포함된 역할·method·skill·schema는 실행 리소스이므로 안내 문서처럼 일괄 수정하지 않는다.
