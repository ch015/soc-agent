# SOC 서비스 API와 중복·장애 처리

기준: 2026-09-22. [설치·Docker·tenant 준비](../README.md) · [서비스 빌드](../service/README.md)

기본 포트는 3001, 큐는 `secops-soc`이다. Bearer tenant API 키를 사용하고 조회·조치 시 소유권을 확인한다.
코드 factory를 직접 호출하는 앱은 이 HTTP 서버·DB·큐가 필요하지 않다.

| 요청 | 현재 동작 |
|---|---|
| `GET /api/v1/health` | 인증 없는 프로세스 상태. 외부 모델·SIEM 준비 검사는 아님 |
| `POST /api/v1/hooks/soc/signal` | signal 검증·중복/상관·할당량 확인·v2 큐 등록. 신규 202 |
| `POST /api/v1/jobs` | domain `soc` 요청 검증·할당량·큐 등록. 신규 201 |
| `GET /api/v1/jobs`, `/:id`, `/:id/result` | tenant job 목록·상세·완료 결과. 결과가 아직 없으면 409 |
| `GET /api/v1/jobs/:id/stream` | SSE, Last-Event-ID 재전송 |
| `DELETE /api/v1/jobs/:id` | 허용 상태에서 취소. worker가 취소를 조사 루프에 전달 |
| `POST /api/v1/jobs/:id/input` | waiting 상태의 입력 저장·재등록. 기본 v2는 질문 대기를 생성하지 않음 |
| `GET /api/v1/tenants/:id` | 자기 tenant 조회 |
| `POST /api/v1/jobs/:id/approve` | action_pending의 approve/deny 및 감사 이력 |
| `GET /api/v1/playbooks`, `/:id` | 내장 observe-notify 정의 조회 |
| `GET /api/v1/audit/actions` | tenant 승인 감사 이력 |

실행 정본은 [router](../src/gateway/router.ts)와 [ingress](../src/gateway/adapters/soc/ingress.ts)다.
잘못된 JSON·job UUID·페이지 수치는 400이다. 목록 `limit`은 1~1000 정수(기본 50),
`offset`은 0 이상의 안전한 정수(기본 0)다.

## 입력과 결과

signal의 필수 값은 signalId·signalType·source·severity·timestamp·subject·tenantId다.
tenantId는 인증된 조직과 일치해야 한다. 요청 예시는 [README](../README.md)에 있다.
v1은 일반 jobs API의 `source.type: snapshot`, `options.missionType`, `options.signal`,
`options.preparedSnapshot`을 사용하며 서명과 tenant/actor를 검증한다.
기본 v2는 읽기·판정·권고를 수행한다. 승인·playbook 라우트가 있어도 자동 차단·격리나 승인 대기를
만들지 않는다. v1 권고도 실행 권한을 부여하지 않는다.

job `completed`와 조사 성공은 다르다. `result.investigationStatus`·`phase`,
`threatLevel`·`decision`·`unresolved`, `actions`·`observations`·`usage`를 확인한다.
`llmUsed`는 호출 여부, `notified`는 Slack API 성공 여부다. `monitoringScheduled`는 false다.
모델·API 실패를 정상 heuristic 판정으로 대체하지 않는다.

## 할당량·중복·재시도

두 POST 경로는 같은 PostgreSQL tenant 행 잠금 아래 중복 확인·할당량·job 생성을 처리한다.
동시·일일 할당량 초과 신규 요청은 429다. 활성 수에는 queued/running/waiting/action_pending/action_executing이 포함된다.
중복 요청은 할당량을 추가 사용하지 않는다.

- signal 중복은 DB의 tenant + signal ID로 확인한다. 상관은 같은 tenant의 subject type/value와 rule ID를 비교한다.
- 기본 중복·상관 창은 5분이다. 일반 jobs는 `options.dedupKey`가 같은 활성 job을 확인한다.
  키는 공백만이 아닌 1~512자 문자열이어야 한다.
- 중복은 기존 `jobId`, `duplicate: true`와 200을 반환한다. 상관은 `correlated: true`다.
  아직 queued인 동일 signal ID/dedupKey는 전달 복구를 위해 5분 이후에도 재사용한다.
  새로운 signal ID의 상관 창은 늘리지 않는다.
- DB 커밋 뒤 Redis 전달이 실패하거나 5초를 넘으면 503과 저장된 `jobId`를 반환한다.
  signal 또는 dedupKey가 있으면 `retryable: true`, `Retry-After: 5`이며 같은 식별자·본문으로 재시도한다.
- dedupKey 없는 일반 요청은 `retryable: false`다. 재제출 전에 반환된 jobId로 상태를 확인한다.
  자동 outbox 재전송은 없고 DB와 Redis는 하나의 트랜잭션이 아니다.

구현은 [admission](../src/gateway/job/admission.ts), 회귀는
[DB 통합](../src/gateway/__tests__/admission.integration.test.ts)과
[전달 장애](../src/gateway/__tests__/admission-delivery.test.ts)를 참조한다.
Redis 캐시 유실·gateway 재시작에도 DB로 중복을 판정한다. 전체 gateway를 새 코드로 전환해야 한다.
이 변경에는 새 DB migration이 필요하지 않다.

## 배포·문서 연결

서비스 의존성은 `service/package.json`에 있다. 저장소 루트에서 `pnpm build:service` 후
`service/`에서 production 설치·start/worker를 실행한다. `.env`도 해당 실행 디렉터리에 둔다.
Compose에는 SOC worker가 포함된다. 외부 SIEM/모델/Slack의 설정과 성공 확인은 별도다.
정책 문서 업로드·검색 API나 `SOC_KNOWLEDGE_CONFIG` 환경변수는 현재 제공하지 않는다.
향후 연결 요청은 [정책 문서 안내](policy-documents.ko.md)를 사용한다.
