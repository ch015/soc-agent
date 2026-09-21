# SOC를 애플리케이션 코드에서 사용하기

문서 기준: 2026-09-21. [현재 기능과 한계](../../docs/development-status.ko.md) · [전체 앱 연동 예제](../../docs/embedding-agents.ko.md)

`src/index.ts`가 공개 진입점입니다. Node.js 22.18 이상 ESM 환경에서 기존 앱의 코드 의존성으로 연결합니다. Kit CLI·통합 tgz·프로젝트 YAML은 필요하지 않습니다.

```sh
pnpm install --frozen-lockfile
pnpm build:library
```

앱의 workspace 또는 pnpm `link:` 의존성으로 이 디렉터리를 연결합니다. 기본 package export는 컴파일한 `dist/src/index.js`와 타입 선언을 사용합니다. TypeScript 실행기를 쓰는 앱은 `secops-soc-agent/source` export도 사용할 수 있습니다. SOC v2 코어의 `dist`에는 조사 코드와 타입만 포함됩니다. v1 도메인 리소스는 서비스 빌드에 포함됩니다.

```js
import { createSocAgent, SocLlmClient } from 'secops-soc-agent';
const agent = createSocAgent({
  llm: new SocLlmClient({ apiKey: secrets.anthropicKey }),
  dataSource: { kind: 'nunchi-core', baseUrl: config.coreUrl, token: secrets.coreToken },
});
const result = await agent.run(alert, { signal: controller.signal });
// result.status: completed | incomplete; observations/actions/result 확인
```

예제의 secrets/config/controller와 업무 입력은 앱이 제공합니다. import는 서버나 worker를 시작하지 않습니다. 모델 키는 인스턴스에 주입하며 process.env나 cwd를 바꾸지 않습니다.

앱의 DB/서비스를 직접 연결하려면 `dataSource: { createConnector(signal) { return { capabilities, execute(name, parameters, abortSignal) { /* 앱 조회 구현 */ } }; } }`를 전달합니다. HTTP 어댑터 서버 없이 기존 함수를 호출할 수 있습니다. adapter는 JSON 업무 증거를 반환하고 실패는 예외, 부분 결과는 `complete:false` 등으로 표시합니다. abortSignal을 실제 조회에도 전달하세요.

앱이 테넌트 접근 권한을 확인해야 합니다. 앱이 호출하는 모델도 `llm.completeTurn()`으로 교체할 수 있습니다. 실행 중 취소/모델 오류는 incomplete로 남으며 입력/설정 오류와 실행 전 취소는 예외가 될 수 있습니다.


## 가벼운 코어와 선택형 서비스

루트의 필수 런타임 의존성은 **Zod 하나**입니다. SDK·Hono·BullMQ·Redis·pg·tsx는
저장소 개발 환경에서만 설치됩니다. 서비스 배포는 `pnpm build:service` 후
[service/package.json](../service/package.json)과 [실행 절차](../service/README.md)를 사용합니다.
Docker도 컴파일된 서비스 코드를 실행합니다. 코어만 쓰는 앱은 이 서비스 설치가 필요하지 않습니다.

`limits.maxConcurrentTools`는 기본 2, 범위 1~4입니다. 모델이 같은 턴에 요청한 독립
조회만 병렬 실행합니다. 다음 조회가 앞선 결과에 의존하면 모델의 다음 턴까지 기다려야 합니다.
증거 ID와 반환 순서는 모델 요청 순서로 고정하며, 같은 턴의 중복 요청도 실제 조회 하나로 합칩니다.
중복 결과에는 본문 대신 기존 증거 ID·성공/부분 여부를 반환합니다.

`SocLlmClient`는 안정된 tools/system prefix의 prompt cache를 기본 요청합니다.
`promptCaching: false`로 끌 수 있습니다. `usage.inputTokens`는 일반 입력 + cache 생성 +
cache 읽기를 합친 값입니다. `cacheReadTokens`, `cacheWriteTokens`는 이 합계에 포함된
세부 항목이므로 다시 더하지 않습니다. 주입한 `llm.completeTurn`도 이 합계 규약을 따릅니다.
실제 cache 적중/비용 절감은 API 응답과 모델별 최소 길이에 따라 달라집니다.

앱에 신뢰할 수 있는 업무 규칙이 있다면 `assessmentGuard({ assessment, observations, signal })`를
옵션으로 전달할 수 있습니다. 동기 함수가 `undefined`를 반환하면 통과하고, 모순이나 미해결
사실을 설명하는 문자열을 반환하면 기존 최대 1회의 최종 교정 기회를 사용합니다. 이후에도
통과하지 못하면 `incomplete`입니다. guard는 복사본을 받아 기본 증거 검증을 우회할 수 없습니다.
이 기능 자체가 임의 API 데이터의 의미적 모순을 자동 판별하지는 않습니다.

```sh
pnpm build:library
pnpm verify:core  # SDK/DB 없는 별도 npm 설치, 엄격한 TS 소비, entity/graph·중복·부분 증거 검사
pnpm test:all
```

검증은 스크립트 모델/HTTP 응답을 사용하며 실제 nunchi-core나 모델 API 호출은 아닙니다.

Zod는 생성된 리소스와 실행 시 스키마의 일치를 위해 검증 버전 `4.4.3`으로 고정했습니다.
버전을 올릴 때는 코어·서비스 lockfile과 생성 리소스를 함께 검증해야 합니다.
