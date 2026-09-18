# SOC를 애플리케이션 코드에서 사용하기

문서 기준: 2026-09-18. [현재 기능과 한계](../../docs/development-status.ko.md) · [전체 앱 연동 예제](../../docs/embedding-agents.ko.md)

`src/index.ts`가 공개 진입점입니다. Node.js 22.18 이상 ESM 환경에서 기존 앱의 코드 의존성으로 연결합니다. Kit CLI·통합 tgz·프로젝트 YAML은 필요하지 않습니다.

```sh
pnpm install --frozen-lockfile
pnpm build:library
```

앱의 workspace 또는 pnpm `link:` 의존성으로 이 디렉터리를 연결합니다. 기본 package export는 컴파일한 `dist/src/index.js`와 타입 선언을 사용합니다. TypeScript 실행기를 쓰는 앱은 `secops-soc-agent/source` export도 사용할 수 있습니다. `dist`의 도메인/템플릿 리소스를 함께 유지하세요.

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
