# SOC 분리 기록

> **포팅 당시 기록.** 아래 288개 테스트와 heuristic 완료는 당시 코드 기준이다. 현재 v2는 모델 주도 도구 루프이며 앱의 직접 connector를 지원한다. [현재 개발 현황](../../docs/development-status.ko.md) · [현재 실행 안내](../README.md)

출처: `secops-nunchi-agent`, HEAD `04f935c0d1301440120bddc8e5647285617fa901`와
포팅 시점 작업 트리. SOC 도메인·v1 미션·v2 모니터·게이트웨이·worker·평가를 독립 프로젝트로 추출했다.

- 필요한 공통 runtime은 프로젝트 안에 포함했다. OffSec/Feedback adapter, finding MCP,
  live DAST, AST/tree-sitter, GitHub PR ingress, Feedback Slack ingress는 제거했다.
- 런타임 도메인과 HTTP job 도메인은 SOC만 허용한다.
- queue/dedup/correlation 이름, DB와 Compose 볼륨을 분리했다.
- 기존 v1 워커의 raw 로그/가짜 trust 객체 캐스팅을 검증된 prepared snapshot 전달로 교체했다.
- v1 보고·조사 CLI, DB migration, tenant 생성 도구를 추가했다.
- 기존 `.env`, 인증정보, engagement 결과, 원본 Git 이력은 복사하지 않았다.
- 기존 schema ID·플러그인명·계약 resource hash를 유지한다.

검증: 독립 `pnpm install --frozen-lockfile`, TypeScript, 33개 suite/288개 test,
계약·JSON Schema 동기화 검사, SOC 고정 평가, Docker 이미지 빌드.
별도 PostgreSQL/Redis와 합성 SIEM 응답으로 health, 인증, tenant 분리, signal ingress,
중복 방지, BullMQ worker의 heuristic 완료, SOC 전용 API, DB migration 재실행을 확인했다.
실제 LLM·SIEM·Slack 자격증명을 사용한 운영 연동은 실행하지 않았다.

원본에서는 SOC 코드·진입점·worker·관련 설정과 테스트를 제거한다. 기존 OffSec 관련
미커밋 수정은 보존한다. 원본 DB나 Redis의 실행 중 작업·기록에는 변경을 가하지 않는다.
원본의 포팅 전 typecheck에는 Zod record 3건과 js-yaml 선언 누락 1건이 있었다.
