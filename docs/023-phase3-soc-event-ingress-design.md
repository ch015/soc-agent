# Phase 3: SOC Event Ingress + 승인 게이트 + 플레이북 설계

> **이전 기록 — 2026-09-18 현행화 메모.** 통합 플랫폼 시점의 설계·운영 기록이다. 현재 OffSec는 모듈/CLI, Feedback와 SOC는 각각 분리된 gateway를 사용한다. 당시 라우트·배포 수량·비용 예상은 현재 운영 보장이 아니다.
> 현재 상태: [개발 현황](../../docs/development-status.ko.md) · [현재 실행 안내](../README.md) · [현재 서비스 API](../../docs/service-api.ko.md)

Status: 설계 (2026-08-12)
Parent: `docs/021-service-platform-architecture.md`

## 1. 목적

`secops-nunchi-*` 프로젝트(SIEM 파이프라인)에서 발생하는 보안 시그널을 수신해
관련 로그를 자동 분석·리포팅하고, 사전 승인된 SOA(Security Orchestration & Automation)
플레이북을 실행하여 위협에 대응한다.

## 2. 현재 상태와 확장 방향

### 현재 구현 (secops-nunchi-agent SOC 도메인)

| 구성요소 | 상태 |
|---|---|
| `socReport()` | sealed snapshot → evidence review → judgment → draft 생성 |
| `socInvestigation()` | query plan → source collect → analysis → draft 생성 |
| `SocSourceAdapter` | 인터페이스 정의됨. 현재 StaticSocSourceAdapter(fixture) 전용 |
| AdvisoryAction | `collect-additional-evidence`, `validate-control`, `request-human-review`, `continue-monitoring` |
| 계약 제한 | Read-only (Bash/Write/Edit/WebFetch/WebSearch 금지), 네트워크 차단 |
| Redaction | Ed25519 서명 기반 trust store. 미서명 입력 거부 |
| Live source | **미구현.** simulator/fixture 경계만 존재 |
| 운영 액션 | **미구현.** 계약에 없음 |

### Phase 3 확장

```
[현재]                         [Phase 3 추가]
sealed snapshot (수동)   →     live signal ingress (자동)
StaticSocSourceAdapter   →     LiveSocSourceAdapter (SIEM 연동)
AdvisoryAction (읽기전용) →     PlaybookExecutor (승인 후 실행)
draft 생성 (끝)         →     알림 + 인시던트 생성 + 대응 액션
```

## 3. 아키텍처

```
secops-nunchi-siem / secops-nunchi-detection / secops-nunchi-collector
        │
        │ 시그널 (alert, detection rule match, anomaly)
        ▼
┌───────────────────────────────────────┐
│  Event Ingress                         │
│  POST /api/v1/hooks/soc/signal         │
│                                        │
│  • 시그널 스키마 검증                  │
│  • 중복 제거 (signal_id)              │
│  • 우선순위 결정 (severity 기반)       │
│  • TenantContext 바인딩               │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  Gateway API                           │
│  • 시그널 → Job 변환                  │
│  • soc queue에 우선순위 큐잉          │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  BullMQ: soc queue (priority)          │
│  • critical/high: 즉시 처리           │
│  • medium/low: 순서대로               │
│  • timeout: 분석 10min / 액션 별도    │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  SOC Analysis Worker                   │
│                                        │
│  1. 로그 수집 (LiveSocSourceAdapter)  │
│     • 시그널 컨텍스트 기반 쿼리       │
│     • 시간 범위 자동 결정             │
│     • 관련 로그 수집 + 봉인           │
│  2. 분석 실행                          │
│     • socReport() 또는                │
│       socInvestigation()              │
│  3. 결과 분류                          │
│     • true positive / false positive  │
│     • severity 재평가                 │
│  4. AdvisoryAction 생성               │
│  5. Progress 이벤트 발행              │
└──────────────────┬────────────────────┘
                   │
                   ▼
┌───────────────────────────────────────┐
│  Approval Gate                         │
│                                        │
│  AdvisoryAction 분류:                 │
│  ├── 자동 승인 → PlaybookExecutor     │
│  ├── 수동 승인 대기 → 운영자 알림    │
│  └── 정보 전달만 → 리포트 발행       │
└─────────┬─────────────┬──────────────┘
          │             │
          ▼             ▼
┌─────────────────┐  ┌──────────────────────┐
│ PlaybookExecutor│  │  Result Router        │
│                 │  │                        │
│ • IP 차단      │  │  • Slack/PD 알림      │
│ • 계정 잠금    │  │  • 인시던트 티켓 생성  │
│ • 격리         │  │  • 리포트 저장         │
│ • WAF 규칙    │  │  • 대시보드 업데이트    │
│ • 알림 발송    │  │                        │
└─────────────────┘  └──────────────────────┘
```

## 4. Event Ingress

### 4.1 시그널 스키마

```typescript
interface SocSignal {
  signalId: string;              // 중복 제거 키
  signalType: 'alert' | 'detection' | 'anomaly' | 'correlation';
  source: string;                // 'secops-nunchi-siem', 'secops-nunchi-detection', ...
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  timestamp: string;             // ISO 8601
  
  // 분석 컨텍스트
  subject: {
    type: 'ip' | 'user' | 'host' | 'service' | 'domain' | 'hash';
    value: string;
  };
  rule?: {
    id: string;
    name: string;
    category: string;            // MITRE ATT&CK tactic/technique
  };
  
  // 시간 범위 힌트 (로그 조회 범위)
  timeContext?: {
    firstSeen: string;
    lastSeen: string;
    suggestedWindow?: string;    // e.g., '1h', '24h'
  };
  
  // 원본 이벤트 참조
  rawEvents?: Array<{
    source: string;
    eventId: string;
    summary: string;
  }>;
  
  // 메타데이터
  tenantId: string;
  tags?: string[];
}
```

### 4.2 우선순위 매핑

| Signal severity | Queue priority | 처리 SLA |
|---|---|---|
| critical | 1 (최고) | < 2분 분석 시작 |
| high | 2 | < 5분 |
| medium | 3 | < 15분 |
| low | 4 | < 1시간 |
| info | 5 | 배치 처리 가능 |

### 4.3 중복 제거 및 코릴레이션

```typescript
interface SignalDeduplication {
  // 동일 signalId → 무시
  bySignalId(signalId: string): boolean;
  
  // 동일 subject + rule + 시간 윈도우 → 기존 job에 병합
  byCorrelation(signal: SocSignal): string | null;  // 기존 jobId or null
}
```

같은 공격의 반복 시그널이 개별 job을 생성하지 않도록, 시간 윈도우(5분) 내
동일 subject+rule 조합은 기존 분석 job에 컨텍스트를 추가한다.

## 5. Live SOC Source Adapter

현재 `SocSourceAdapter` 인터페이스를 구현하는 live adapter:

```typescript
interface LiveSocSourceAdapter extends SocSourceAdapter {
  // 시그널 기반 자동 쿼리 플랜 생성
  buildQueryPlan(signal: SocSignal): SocQueryPlan;
  
  // 실시간 로그 수집 (페이지네이션 + rate limit 준수)
  collect(plan: SocQueryPlan, auth: SocAuthorizationContext): Promise<SocPreparedSnapshot>;
  
  // 연결 대상
  readonly sourceType: 'elasticsearch' | 'splunk' | 'cloudwatch' | 'custom';
}
```

### 5.1 로그 소스 연동

| 소스 | 연동 방식 | Phase 3 범위 |
|---|---|---|
| secops-nunchi-collector (ES/OpenSearch) | REST API | ✓ 초기 구현 |
| Splunk | REST API | 확장 |
| CloudWatch Logs | AWS SDK | 확장 |
| Custom (webhook push) | 시그널에 raw events 포함 | ✓ fallback |

### 5.2 수집 제한 (안전 경계)

| 제한 | 값 | 근거 |
|---|---|---|
| 최대 쿼리 시간 범위 | 24시간 | 과도한 로그 방지 |
| 최대 수집 행 수 | 10,000 | 메모리/비용 제한 |
| 최대 수집 바이트 | 50MB | 모델 입력 상한 |
| 쿼리 timeout | 60초 | source 장애 격리 |
| Rate limit | 10 req/sec per source | source 부하 방지 |

수집 후 반드시 **redaction + 봉인**을 거쳐 `SocPreparedSnapshot`으로 변환.
Redaction trust store는 Vault에서 Ed25519 키 로드.

## 6. Approval Gate (승인 게이트)

### 6.1 설계 원칙

- **분석·리포트는 항상 자동** — 시그널 수신 즉시 분석 시작, 승인 불필요
- **대응 액션만 승인 대상** — 운영에 영향을 주는 행위만 게이트 통과 필요
- **정책 기반 자동 승인** — 사전 정의된 조건 만족 시 사람 개입 없이 실행
- **수동 승인은 시간 제한** — 미응답 시 에스컬레이션, 절대 무한 대기 아님

### 6.2 액션 분류 및 승인 수준

```typescript
type ActionCategory = 'observe' | 'contain' | 'eradicate' | 'recover';

interface ApprovalPolicy {
  // 자동 승인 조건
  autoApprove: {
    categories: ActionCategory[];     // e.g., ['observe'] → 모니터링 강화는 자동
    maxSeverityForAuto: 'high';       // critical은 항상 수동
    requireMinConfidence: number;     // 분석 신뢰도 임계값
    allowedActionTypes: string[];     // 허용된 자동 액션 목록
  };
  
  // 수동 승인 설정
  manualApproval: {
    channel: 'slack' | 'pagerduty' | 'email';
    timeout: string;                  // e.g., '15m', '1h'
    escalation: {
      after: string;                  // timeout 후 에스컬레이션
      to: string;                     // 에스컬레이션 대상
    };
    quorum?: number;                  // 승인 필요 인원 (default: 1)
  };
  
  // 절대 금지 (자동이든 수동이든 실행 불가)
  blocked: string[];                  // e.g., ['delete-data', 'shutdown-service']
}
```

### 6.3 승인 흐름

```
AdvisoryAction 생성
        │
        ▼
┌───────────────────┐
│ 정책 평가          │
│                   │
│ blocked?          │──── YES ──→ 거부 + 감사 기록
│   │               │
│   NO              │
│   ▼               │
│ autoApprove 조건? │──── YES ──→ 즉시 실행 + 감사 기록
│   │               │
│   NO              │
│   ▼               │
│ 수동 승인 요청    │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ 운영자 알림        │
│ (Slack/PagerDuty) │
│                   │
│ 승인 / 거부 / 무응답 │
└──┬─────┬─────┬────┘
   │     │     │
   ▼     ▼     ▼
 실행   거부  timeout
  +     +     → 에스컬레이션
 감사   감사    → 상위 승인자
 기록   기록
```

### 6.4 감사 기록 (Audit Trail)

모든 승인 결정은 불변 이벤트로 기록:

```typescript
interface ApprovalAuditEvent {
  jobId: string;
  actionKey: string;
  actionType: string;
  decision: 'auto-approved' | 'manually-approved' | 'denied' | 'escalated' | 'blocked' | 'timed-out';
  decidedBy: string;              // 'policy:auto' | 'operator:username' | 'system:timeout'
  decidedAt: string;
  policyVersion: string;
  rationale?: string;
  evidence: {
    signalSeverity: string;
    analysisConfidence: number;
    matchedPolicyRule: string;
  };
}
```

## 7. Playbook Executor

### 7.1 플레이북 정의

```typescript
interface Playbook {
  id: string;
  name: string;
  version: string;
  category: ActionCategory;
  
  // 실행 조건
  trigger: {
    actionTypes: string[];          // 매칭되는 advisory action types
    signalCategories?: string[];    // MITRE ATT&CK 카테고리
  };
  
  // 실행 단계
  steps: PlaybookStep[];
  
  // 롤백 (실패 시)
  rollback?: PlaybookStep[];
  
  // 제한
  limits: {
    maxExecutionTime: string;       // e.g., '5m'
    maxAffectedEntities: number;    // 폭발 반경 제한
    requireConfirmationAbove: number; // N개 이상 영향 시 재확인
  };
}

interface PlaybookStep {
  id: string;
  action: string;                   // 'block-ip' | 'disable-user' | 'isolate-host' | ...
  target: string;                   // 동적 바인딩: signal subject에서 추출
  params?: Record<string, unknown>;
  timeout: string;
  continueOnFailure: boolean;
}
```

### 7.2 지원 액션 (Phase 3 초기)

| 액션 | 카테고리 | 대상 | 자동 승인 가능 |
|---|---|---|---|
| `increase-monitoring` | observe | 로그 수집 주기 증가 | ✓ |
| `create-incident` | observe | 인시던트 티켓 생성 | ✓ |
| `notify-team` | observe | Slack/PD 알림 발송 | ✓ |
| `block-ip` | contain | 방화벽/WAF 규칙 추가 | severity=critical 시 자동 |
| `disable-user` | contain | 계정 일시 잠금 | 수동 승인 필수 |
| `isolate-host` | contain | 네트워크 격리 | 수동 승인 필수 |
| `revoke-token` | eradicate | API 토큰/세션 무효화 | severity=critical 시 자동 |
| `update-waf-rule` | contain | WAF 패턴 추가 | 수동 승인 필수 |

### 7.3 실행 및 롤백

```
Playbook 실행 시작
     │
     ▼
Step 1 ──── 성공 ──→ Step 2 ──── 성공 ──→ Step 3 ──→ 완료 + 기록
     │                  │
   실패                실패
     │                  │
     ▼                  ▼
  rollback?          rollback Step 1
  NO → failed        → failed + partial rollback 기록
```

- 각 step의 성공/실패는 개별 기록
- `continueOnFailure: true`면 다음 step 계속
- rollback은 역순으로 실행한 step만 되돌림
- rollback 실패 시 **에스컬레이션** (수동 개입 필요)

### 7.4 Action Connector 인터페이스

실제 인프라 변경은 Connector가 담당:

```typescript
interface ActionConnector {
  id: string;                          // 'aws-waf' | 'okta' | 'paloalto' | ...
  supportedActions: string[];
  execute(action: PlaybookStep, context: ExecutionContext): Promise<ActionResult>;
  rollback?(action: PlaybookStep, context: ExecutionContext): Promise<ActionResult>;
  healthCheck(): Promise<boolean>;
}

interface ActionResult {
  success: boolean;
  affectedEntities: string[];
  details: Record<string, unknown>;
  rollbackCapable: boolean;
}
```

Phase 3 초기: `slack-notify`, `jira-incident`, `generic-webhook` connector.
실제 인프라 차단(`aws-waf`, `okta`, `firewall`) connector는 운영 검증 후 순차 추가.

## 8. secops-nunchi-* 연동

### 8.1 시그널 발신 측 (secops-nunchi-siem / detection)

```yaml
# secops-nunchi-detection의 alert 발생 시
POST https://gateway.example.com/api/v1/hooks/soc/signal
Authorization: Bearer <service-api-key>
Content-Type: application/json

{
  "signalId": "det-20260812-abc123",
  "signalType": "detection",
  "source": "secops-nunchi-detection",
  "severity": "high",
  "timestamp": "2026-08-12T09:15:00Z",
  "subject": { "type": "ip", "value": "203.0.113.42" },
  "rule": {
    "id": "T1078.004",
    "name": "Valid Accounts: Cloud Accounts",
    "category": "initial-access"
  },
  "timeContext": {
    "firstSeen": "2026-08-12T09:10:00Z",
    "lastSeen": "2026-08-12T09:15:00Z",
    "suggestedWindow": "1h"
  },
  "tenantId": "tenant-internal"
}
```

### 8.2 로그 수집 (secops-nunchi-collector → LiveSocSourceAdapter)

```
SOC Worker
    │
    │ query (subject=ip:203.0.113.42, time=09:10~10:10)
    ▼
secops-nunchi-collector (ES/OpenSearch)
    │
    │ 로그 반환 (최대 10,000행, 50MB)
    ▼
SOC Worker
    │ redaction + 봉인 → SocPreparedSnapshot
    ▼
socReport() / socInvestigation()
```

## 9. Job Lifecycle (SOC 특화)

```
signal received → queued (priority) → running
                                        │
                     ┌──────────────────┼──────────────────┐
                     │                  │                   │
                     ▼                  ▼                   ▼
              log_collecting      analyzing           action_pending
                     │                  │                   │
                     ▼                  ▼                   ▼
              analysis_complete   report_generated    ┌─────────────┐
                                       │             │ approval_gate│
                                       │             └──────┬──────┘
                                       │                    │
                                       ▼                    ▼
                                   completed          action_executing
                                   (리포트만)              │
                                                           ▼
                                                      completed
                                                   (리포트 + 액션)
```

SOC job은 분석 완료 후 **두 갈래**:
- AdvisoryAction이 정보 전달만(`observe`) → 바로 completed
- 대응 필요(`contain`/`eradicate`) → approval gate → playbook execution

## 10. 알림 및 에스컬레이션

| 이벤트 | 알림 대상 | 채널 |
|---|---|---|
| Critical 시그널 수신 | SOC 팀 전체 | PagerDuty (즉시) |
| 분석 완료 (true positive) | 담당 운영자 | Slack 채널 |
| 승인 대기 | 승인 권한자 | Slack DM + PagerDuty |
| 승인 timeout | 에스컬레이션 대상 | PagerDuty (긴급) |
| 플레이북 실행 완료 | SOC 팀 + 관련 팀 | Slack + 티켓 업데이트 |
| 플레이북 실패/롤백 | SOC 팀 (긴급) | PagerDuty + Slack |
| False positive | 탐지 규칙 담당 | Slack (개선 제안) |

## 11. 보안 고려

| 위협 | 대응 |
|---|---|
| 시그널 위조 | Service API key + 허용 source IP 제한 |
| 과도한 시그널 (DoS) | Rate limit (100 signals/min per tenant) + 코릴레이션 |
| 로그 소스 접근 | Vault에서 source credential 관리. Worker에만 주입 |
| 플레이북 오남용 | ApprovalPolicy + maxAffectedEntities + blocked list |
| 감사 추적 우회 | AuditEvent는 append-only. 삭제/수정 불가 |
| 민감 로그 유출 | Redaction trust store + model에는 redacted snapshot만 |
| 모델 hallucination | AdvisoryAction의 evidenceLocators가 snapshot에 없으면 거부 |

## 12. Tenant SOC 설정

```typescript
interface SocTenantConfig {
  // 시그널 소스 인증
  signalSources: Array<{
    name: string;
    apiKeyRef: string;            // Vault path
    allowedIps?: string[];
  }>;
  
  // 로그 소스 연동
  logSource: {
    type: 'elasticsearch' | 'splunk' | 'cloudwatch';
    endpoint: string;
    credentialRef: string;        // Vault path
    index?: string;
  };
  
  // 승인 정책
  approvalPolicy: ApprovalPolicy;
  
  // 플레이북 활성화
  enabledPlaybooks: string[];     // playbook IDs
  
  // 알림 채널
  notifications: {
    critical: { channel: string; pagerdutyService?: string };
    high: { channel: string };
    approval: { channel: string; mentions: string[] };
  };
}
```

## 13. API 엔드포인트 (Phase 3 추가분)

```yaml
# 시그널 수신 (secops-nunchi-* 가 호출)
POST /api/v1/hooks/soc/signal

# 승인 응답 (운영자 또는 Slack interactive)
POST /api/v1/jobs/:id/approve       # { decision: 'approve' | 'deny', rationale }
POST /api/v1/hooks/slack/soc-approve  # Slack button callback

# 플레이북 관리
GET  /api/v1/playbooks
GET  /api/v1/playbooks/:id
POST /api/v1/playbooks/:id/test     # dry-run (실제 실행 안 함)

# Tenant SOC 설정
GET  /api/v1/tenants/:id/soc-config
PUT  /api/v1/tenants/:id/soc-config

# 감사 로그
GET  /api/v1/audit/actions?job=&tenant=&from=&to=
```

## 14. Phase 1/2 와의 공유/재사용

| 구성요소 | Phase 1/2에서 이미 구현 | Phase 3에서 추가 |
|---|---|---|
| Gateway API 서버 | ✓ | signal 라우트 + approve 라우트 |
| Job lifecycle | ✓ | SOC 확장 상태 (action_pending, action_executing) |
| BullMQ 큐 | ✓ | soc queue (priority 지원) |
| PostgreSQL | ✓ | approval_events, playbook_executions 테이블 |
| Result Router | ✓ | PagerDuty + incident connector 추가 |
| SSE progress | ✓ | SOC 단계별 이벤트 추가 |
| Tenant 인증 | ✓ | service-to-service API key 추가 |
| Vault/VSO | ✓ | source credential + redaction key 추가 |
| Docker Compose | ✓ | soc-worker + mock-siem 서비스 추가 |

## 15. 최소 Docker Compose 추가분

```yaml
services:
  soc-worker:
    build: .
    command: ["node", "--import", "tsx", "src/gateway/workers/soc-worker.ts"]
    environment:
      - REDIS_URL=${REDIS_URL}
      - DATABASE_URL=${DATABASE_URL}
      - LOG_SOURCE_ENDPOINT=${LOG_SOURCE_ENDPOINT}
      - ARTIFACT_BUCKET=${ARTIFACT_BUCKET}
    deploy:
      replicas: 3
      resources:
        limits:
          memory: 4G

  # 로컬 테스트용 mock SIEM
  mock-siem:
    build: ./test/mock-siem
    ports:
      - "9200:9200"
```

## 16. 구현 순서

```
3-1. SocSignal 스키마 + Event Ingress 라우트 (서명 검증 + 중복 제거)
3-2. 시그널 → Job 변환 + priority queue 연동
3-3. LiveSocSourceAdapter (ES/OpenSearch 연동)
3-4. SOC Analysis Worker (시그널 → 수집 → socReport/Investigation)
3-5. ApprovalPolicy 엔진 + 자동/수동 분류
3-6. 승인 알림 (Slack interactive button)
3-7. PlaybookExecutor 프레임워크 + 감사 기록
3-8. 초기 Connector: slack-notify, jira-incident, generic-webhook
3-9. 인프라 Connector: block-ip (Phase 3 후기, 운영 검증 후)
3-10. 코릴레이션 + 에스컬레이션 로직
3-11. 통합 테스트 (mock SIEM 시그널 → 분석 → 승인 → 액션)
```

## 17. 제외 (Phase 3 범위 밖)

| 항목 | 이유 | 도입 시점 |
|---|---|---|
| SOAR 플랫폼 완전 대체 | 범위 과대. 보조/자동화 도구 위치 | 별도 프로젝트 |
| 탐지 규칙 자동 튜닝 | 탐지 엔진은 secops-nunchi-detection 소관 | 연동 API로 제안만 |
| 위협 인텔리전스 자동 수집 | 외부 서비스 의존. 별도 예산/계약 | Phase 4+ |
| 멀티 소스 코릴레이션 엔진 | SIEM 기능. 이중 구현 불필요 | SIEM 측 강화 |
| 포렌식 수준 메모리/디스크 분석 | 에이전트 분석 범위 초과 | 전문 도구 연동 |
| 실시간 스트리밍 분석 (CEP) | 배치 분석만 Phase 3 범위 | Phase 4+ |

## 18. 안전 경계 (강조)

SOC Phase 3은 **운영 영향이 가장 큰 도메인**이므로 다음을 엄격히 준수:

1. **분석은 항상 Read-only** — 기존 SOC 계약(`Bash`/`Write`/`Edit` 금지) 그대로 유지
2. **액션은 계약에 없는 것을 실행할 수 없다** — PlaybookStep.action이 등록된 Connector에 없으면 거부
3. **자동 승인은 보수적 기본값** — 초기 배포 시 `observe` 카테고리만 자동. 나머지 수동
4. **폭발 반경 제한** — `maxAffectedEntities` 초과 시 무조건 수동 승인 재요청
5. **롤백 실패 = 즉시 에스컬레이션** — 시스템이 복구 불능 상태를 방치하지 않음
6. **감사 추적은 불변** — 모든 결정·실행·롤백이 append-only로 기록됨
7. **모델 출력을 직접 실행하지 않음** — AdvisoryAction → 정책 평가 → Connector. 모델이 임의 명령을 실행할 경로 없음
