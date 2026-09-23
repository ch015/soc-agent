# secops-soc-agent

문서 기준: 2026-09-23. [현재 개발 현황](docs/development-status.ko.md) · [문서 목록](docs/README.md)

기존 앱에서 직접 호출하는 공개 API: [`createSocAgent`](src/index.ts). `pnpm build:library` 후 모듈 import로 사용할 수 있습니다. [코드 연동 가이드](docs/embedding.md)

SOC 전용 라이브러리와 독립 서비스. `secops-nunchi-agent`에서 실시간 관제(v2), 서명된 스냅샷 기반
보고·조사(v1), HTTP 게이트웨이, 워커, 계약과 평가 도구를 분리했다.
다른 프로젝트의 코드·플러그인·node_modules를 참조하지 않는다.

## 앱 코드 연동

`createSocAgent()`에 모델과 `dataSource`를 전달한다. `dataSource.createConnector(signal)`로
앱의 기존 DB/조회 서비스를 직접 연결하거나 `nunchi-core` / `http-json` HTTP connector를
선택한다. [연동 가이드](docs/embedding.md)와 [8개 도구의 데이터 규약](docs/data-connectors.md)을 참조한다.
코드 연동의 필수 런타임 의존성은 Zod 하나다. SDK/PostgreSQL/Redis/Slack 없이 실행한다.
Gateway·worker·v1 실행은 [선택형 서비스 빌드](service/README.md)에 기존 의존성을 유지한다.

## 정책·지침 참조

[지원 정책 목록과 문서 추가 프롬프트](docs/policy-documents.ko.md)에 현재 지침과 향후 등록 요청을 정리했다.
내부 조사·증거 검증 지침은 실행 중 사용한다. MITRE ATT&CK는 전술 문자열 출력만 지원한다.
외부 표준 원문·조항 색인·조직 정책 RAG는 아직 SOC에 연결되지 않았다.

## 기존 서비스 실행

Node.js **22.18 이상**, pnpm **9.15.0**을 사용한다.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate
pnpm tenant:create local-soc
pnpm start
# 다른 터미널
pnpm worker
```

`tenant:create`가 출력한 tenant ID와 API 키를 시그널 발신기에 설정한다.
게이트웨이는 기본 `http://localhost:3001`에서 실행된다. `.env`는 start/worker/DB/mission
명령에서 자동으로 읽는다. 마이그레이션은 SOC 전용 DB에 적용하며 재실행할 수 있다. 현재 버전은 `003-workflow-deliveries.sql`까지 필요하다. 기존 배포는 구버전 Gateway/worker를 중지한 뒤 migration과 새 프로세스 시작을 진행한다.

v2 운영에는 `.env`의 `SIEM_BE_BASE_URL`, `SIEM_BE_SERVICE_TOKEN`,
`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, Slack 채널을 설정한다.
v2는 모델이 nunchi-core/SIEM 조회 도구를 선택하는 조사 루프를 사용한다. API 키가 없거나
모델 호출이 실패하면 `incomplete / inconclusive`로 남기고 담당자 검토를 요청한다.
SIEM BE는 HTTP로 연결하는 외부 데이터 서비스이며 로컬 체크아웃은 필요하지 않다.
행동 기준과 실행 상한은 [자율 조사 운영 지침](docs/agent-autonomy.md)을 참조한다.

```bash
curl http://localhost:3001/api/v1/health
curl -X POST http://localhost:3001/api/v1/hooks/soc/signal \
  -H 'Authorization: Bearer <tenant-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{"signalId":"demo-001","signalType":"detection","source":"local-test","severity":"low","timestamp":"2026-09-10T00:00:00Z","subject":{"type":"ip","value":"203.0.113.42"},"tenantId":"<tenant-id>"}'
curl -H 'Authorization: Bearer <tenant-api-key>' http://localhost:3001/api/v1/jobs/<job-id>
```

## Docker

```bash
docker compose up --build -d
docker compose run --rm gateway node dist/scripts/create-tenant.js local-soc
docker compose logs -f gateway soc-worker
docker compose down
```

게이트웨이·워커·마이그레이션은 같은 SOC 전용 이미지를 사용한다. PostgreSQL, Redis,
engagement 볼륨은 Compose 프로젝트에 속하며, 기존 서비스와 분리된다.
로컬 포트는 HTTP 3001, PostgreSQL 55433, Redis 56380이다.
컨테이너에서 호스트의 SIEM을 사용하면 `SIEM_BE_BASE_URL=http://host.docker.internal:8080`으로
설정한다. 기본 Compose 구성은 v2 관제용이다. v1은 아래 로컬 CLI를 사용하거나,
공개키 파일을 워커에 읽기 전용으로 마운트하고 `SOC_REDACTION_*` 환경변수를 전달한다.
SDK sandbox가 지원되지 않는 환경에서는 v1이 실행을 거부한다.

## v1 보고·조사

모델에는 신뢰된 redaction producer가 서명한 prepared snapshot만 전달한다.
`SOC_REDACTION_ISSUER`, `SOC_REDACTION_KEY_ID`, `SOC_REDACTION_PUBLIC_KEY_FILE`로
호스트의 Ed25519 공개키를 설정한다. 원본 데이터·서명 키·기존 `.env`는 이 프로젝트에 복사하지 않는다.

```bash
pnpm soc:run --help
pnpm soc:run --snapshot /absolute/path/report.json --mission report \
  --tenant tenant-1 --actor actor-1 --engagement-dir /tmp/soc-report-001
pnpm soc:run --snapshot /absolute/path/investigation.json --mission investigation \
  --tenant tenant-1 --actor actor-1 --engagement-dir /tmp/soc-investigation-001
```

`report`: evidence-review → judge → verify.
`investigation`: evidence-review → analyze → verify.
기본 모델은 opus/sonnet이며 `--model`, `--review-model`, `--max-turns`로 변경한다.
서명·tenant/actor·query receipt·증거 참조를 검증하고 내부 draft를 생성한다.
`held` 결과는 종료 코드 2를 반환한다. v1의 advisory action은 실행 권한을 부여하지 않는다.
미리 봉인하지 않은 producer 결과는 `createSocPreparedSnapshot()`으로 검증·봉인할 수 있다.

HTTP `POST /api/v1/jobs`에서 `domain: "soc"`, `source: {"type":"snapshot"}`,
`instruction`, `callback: {"type":"poll"}`, `options.missionType`, `options.signal`,
`options.preparedSnapshot`을 전달하면 같은 워커가 v1으로 분기한다.
이 경로에서는 snapshot의 tenantId와 actorId 모두 인증된 tenant ID여야 한다.
일반 signal ingress는 v2로 처리한다. `SOC_HANDLER_VERSION=v1`은 준비된 snapshot을
제출하는 클라이언트에 한해 사용한다.

## 구조와 호환성

| 경로 | 역할 |
|---|---|
| `domains/soc/` | SOC 에이전트·방법론·버전 계약·JSON Schema |
| `src/gateway/` | 인증, signal ingress, jobs/SSE, SOC worker, 승인·playbook·callback 기반 코드 |
| `src/index.ts`, `src/api/` | 공개 factory와 앱 설정 연결 |
| `src/runtime/investigation/` | v2 모델·도구 루프·connector·signal·판정 규칙 |
| `src/runtime/` | v1 세션 격리, 증거 검증, workflow/state/lease/artifact 및 단건 v2 미션 |
| `scripts/` | 서버 운영, DB·tenant 준비, SOC CLI, 계약 생성·검사 |
| `evals/soc/` | 고정 평가 정책과 사례 |

큐 이름은 **`secops-soc`**이다. signal 중복·상관과 일반 `options.dedupKey`의 판정은
PostgreSQL에 저장된 작업을 기준으로 한다. 두 수신 경로의 중복 확인·할당량·생성을
테넌트 행 잠금으로 묶고 실행 요청도 같은 DB 트랜잭션에 저장한다. 즉시 큐 전달 실패는 503과 jobId를 반환하며 outbox dispatcher도 미전달 요청을 재시도한다.
[중복 창·동일 요청 재시도·배포 조건](docs/service-api.ko.md)을 확인한다.
기존 큐·DB의 진행 중 job은 자동 이전하지 않는다. 생산자 URL과 tenant 키를 새 서비스로
전환하고 기존 job을 drain한 뒤 이전 워커를 중단한다.
`nunchi.soc.*` 스키마 ID와 `nunchi-soc` 플러그인 이름은 기존 계약·서명 호환성을 유지한다.
OffSec/Feedback 미션·워커·도메인 플러그인·코드 수집 및 AST 의존성은 포함하지 않는다.

v2는 필요한 조회를 모델이 고르는 루프다. 모델/API 실패를 정상 heuristic 판정으로 대체하지 않는다.
큐의 `completed`만으로 조사 성공이나 알림 전달을 단정하지 않고 `result.investigationStatus`,
`phase`, `llmUsed`, `notified`를 함께 확인한다. `monitoringScheduled`는 false다.
승인·playbook 기반 코드와 기본 v2 조사 연결 범위는 [서비스 API](docs/service-api.ko.md)를 참조한다.
실제 모델·SIEM·Slack 연결은 해당 환경의 설정과 자격증명이 필요하다.

## 검증

```bash
pnpm test:all
pnpm check:contracts
pnpm eval:soc
```

테스트는 모델 호출 없이 실행한다. `eval:soc`은 고정 산출물 평가이며 실제 관제 성능을
측정하지 않는다. 계약 ID·리소스 해시는 검증하며, 수정 시 스키마와 manifest를 재생성한다.
`docs/002-*`, `docs/006-*`, `docs/023-*`은 포팅 이전 설계 기록이다.

워크플로우 장애 복구·재시도·2026-09-23 마이그레이션은 [운영 안내](docs/workflow-recovery.ko.md)를 참조하세요.
