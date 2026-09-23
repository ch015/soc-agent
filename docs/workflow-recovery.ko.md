# 워크플로우 복구 — 2026-09-23

Gateway 작업 생성 및 보완 입력/승인의 상태 변경과 실행 전달 요청을 PostgreSQL `gateway_outbox`에 함께 저장한다. Gateway 또는 worker의 주기적 dispatcher가 Redis 장애 후 미전달 요청을 다시 전송한다. 기존 admission의 즉시 전송·503 응답 규약도 유지하므로 재요청 시 같은 signal ID 또는 `options.dedupKey`를 사용한다.

## 업그레이드

기존 Gateway와 worker를 중지한 뒤 Node 22.18 이상에서 Gateway `DATABASE_URL`을 설정하고 `pnpm db:migrate`를 실행한다. 컴파일된 서비스는 `service/`에서 같은 명령을 실행한다. 이번 버전에는 `003-workflow-deliveries.sql`이 추가됐다. Compose의 migrate 서비스도 이를 적용한다. migration 적용 후 새 Gateway와 worker를 함께 시작하며 이전 worker와 혼용하지 않는다.

기존 작업/콜백을 소급 복구하는 migration은 아니다. 남아 있는 이전 작업은 실행 기록과 큐 상태를 대조한다. 새 작업부터 원자적 전달을 보장한다.

## 실행과 알림

- 상태 변경은 현재 상태/version을 비교한다. 실행별 token으로 취소되거나 다른 worker가 인계한 실행의 늦은 DB 변경을 차단한다.
- `queueConfig.timeout`이 실제 실행 제한 시간으로 적용된다. 시간 초과 시 AbortSignal과 실패 기록을 남긴다. 취소된 작업은 약 1초 주기로 확인해 실행에 전달한다. 사용자 정의 함수가 신호를 무시하면 외부 부작용까지 강제 종료할 수는 없다.
- 반복 worker 종료로 BullMQ가 stalled 복구를 포기하면 이벤트와 주기적 대조로 running/action_executing 상태를 failed로 정리한다. 완료되지 않은 분석을 성공으로 바꾸지 않는다.
- 수동 승인 입력은 DB에 저장하고 기존 최초 전달과 다른 큐 ID를 사용한다. `action_executing` 재개 시 동일 상태로 다시 전이하려다 실패하지 않는다. 기존 승인 권한·감사 기록은 유지한다.
- 일반 결과 콜백은 waiting/completed/failed 상태 변경과 함께 저장하고, 실패 시 1~60초 backoff로 독립 재전송한다. HTTP 오류나 전달 설정 누락을 성공 처리하지 않는다. 웹훅은 고정 `Idempotency-Key`를 사용한다. ACK 유실 시 중복 전달이 가능하므로 수신 측 멱등 처리가 필요하다.
- SOC Monitor의 별도 Slack escalation 전송은 여전히 best-effort이며 결과에 `notified`/실패 사유를 남긴다. 이번 일반 callback outbox와 구분한다. 운영 playbook의 외부 부작용에 대한 exactly-once 실행을 보장하지 않는다.

```sql
SELECT id, job_id, kind, attempts, available_at, last_error
FROM gateway_outbox WHERE delivered_at IS NULL ORDER BY created_at;
```

Gateway/worker 가동, DB와 Redis 영속성 및 artifact 접근이 필요하다. Redis 전체 데이터 유실이나 큐 기록 강제 삭제는 자동 복구 범위 밖이다. outbox 정리·모니터링 정책은 운영자가 지정한다. 실제 SIEM·모델·Slack·운영망 검증을 완료했다는 의미는 아니다.

독립 lease 스키마에서 해제 시 존재하지 않는 `updated_at` 컬럼을 쓰던 오류도 수정했다. 이 수정은 OffSec에도 적용한다. lease 해제는 만료 시각만 갱신하고 fencing token의 단조 증가와 오래된 소유자 차단을 유지한다.
