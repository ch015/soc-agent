# 플러그인 계약 — 관측된 사실

> **이전 기록 — 2026-09-18 현행화 메모.** 본문의 설계·명령·경로·수치와 완료 표시는 작성 당시 기록이며 현재 지원 범위를 보장하지 않는다.
> 현재 상태: [개발 현황](../../docs/development-status.ko.md) · [현재 실행 안내](../README.md)

> 상태: 역사적 SDK 관측 기록. 전체 진단의 현재 실행 표준은
> `domains/offsec/contracts/offsec-contract.v1.json`이다. F8의 프롬프트 기반 foreground
> 우회와 plugin agent fallback은 명시적 `Options.agents` + 역할별 top-level 세션으로
> 대체됐다. 나머지 관측은 플러그인 호환성 근거로 유지한다.

> 작성: 2026-08-03. 근거는 전부 `scripts/probe-plugin-contract.ts` 실행 결과다.
> 추론으로 적은 항목은 없다. 재현: `pnpm tsx scripts/probe-plugin-contract.ts`

`docs/001`은 "산출물에서 역산해 TS로 새로 만든다"였다. 이 문서는 그중
**게이트·원장·불변식을 TS로 재작성한다는 부분을 대체한다.** `../ch015-pentester`가
같은 것을 12,645줄의 검증된 JS로 이미 갖고 있고, SDK가 그것을 그대로 실행한다는 것이
관측되었기 때문이다. Finding 계약(I1/I2/I3)과 도메인 3분할은 그대로 유효하다.

## F1. 플러그인 커맨드 훅은 SDK 세션에서 발화한다 — 위치가 정해져 있다

| 매니페스트 위치 | 발화 |
|---|---|
| `<plugin>/hooks/hooks.json` | **발화함** |
| `<plugin>/hooks.json` (플러그인 루트) | 발화하지 않음 |
| `Options.settings.hooks` (인라인 객체) | **발화함** |

관측된 이벤트: `SessionStart`, `UserPromptSubmit`, `PreToolUse`(Read/Agent),
`PostToolUse`, `SubagentStop`, `Stop`. 총 26행이 원장에 기록되었다.

- `${CLAUDE_PLUGIN_ROOT}`는 플러그인 디렉토리 절대경로로 치환된다.
- 훅 프로세스의 `cwd`는 **세션 cwd(진단 대상)** 이고 플러그인 디렉토리가 아니다.
  따라서 커맨드는 `./hooks/x.js` 같은 상대경로를 쓸 수 없고 `${CLAUDE_PLUGIN_ROOT}`가
  필수다. (ch015의 플러그인 루트 `hooks.json`이 상대경로를 쓰는데, 그 파일은 애초에
  발화하지 않는다.)
- `settingSources: []`는 플러그인 훅을 막지 않는다. 격리와 훅은 독립이다.
- `SubagentStop` 훅 입력에 `agent_id`/`agent_type`이 실려 온다 →
  커맨드 훅에서도 서브에이전트 귀속이 가능하다.

`Options.settings.hooks`가 동작하므로 `~/.claude/settings.json`을 건드리지 않고도
호스트가 세션 단위 훅을 추가할 수 있다. ch015의 `install.sh`가 설치 시 전역 settings에
머지하던 것(`install.sh:407-418`)을 세션 조립 시점으로 옮길 수 있다.

## F2. 플러그인 에이전트 이름은 `<플러그인>:<하위경로>:<이름>`

```
agents/probe-limited.md          → probe-group:probe-limited
agents/nested/probe-nested.md    → probe-group:nested:probe-nested
```

이 실행에서 bare 별칭(`probe-limited`)은 생기지 않았다. 위임 시 전체 이름을 써야 한다.

부수 관측: `settingSources: []` 에서도 빌트인 에이전트(`claude`, `Explore`,
`general-purpose`, `Plan`, `statusline-setup`)는 목록에 남는다. 보안 그룹이
일반 목적 에이전트에 작업을 흘리지 않게 하려면 별도 조치가 필요하다 — 미해결.

## F3. 프론트매터 `tools:`는 서브에이전트 도구를 실제로 제한한다

`tools: Read` 만 준 에이전트에게 `permissionMode: 'bypassPermissions'` 상태에서
Bash 실행을 유도했더니 `BASH_UNAVAILABLE`을 반환했고, 원장에 서브에이전트의 Bash
호출이 없었다. 권한이 아니라 **도구 노출** 이 원인임을 분리하기 위해 권한을 통과시킨
상태로 측정했다.

`docs/001` §5의 미해결 질문("플러그인 `.md`의 `tools:`가 실제로 제한하는가")이 닫혔다.
`supportedAgents()`가 `name`/`description`/`model`만 돌려주는 것은 그 API의 한계이고,
제한 자체는 걸린다.

## F4. 이 리포는 ESM, ch015 자산은 CommonJS

`package.json`에 `"type": "module"`이 있어 ch015의 `require` 기반 `.js`를 그대로 두면
`ReferenceError: require is not defined in ES module scope`로 즉사한다.
(프로브 1~5회차가 "훅 미발화"로 보인 원인이 바로 이것이었다 — 플랫폼 문제가 아니었다.)

해결: 벤더 디렉토리에 `package.json`으로 모듈 타입을 국소화한다. Node는 가장 가까운
`package.json`의 `type`을 따르므로 ESM 리포 안에서 CJS 트리가 그대로 동작한다.
직접 확인했다.

```
domains/offsec/vendor/ch015/package.json   → {"type":"commonjs"}
domains/offsec/vendor/ch015/lib/**          ← 무수정 복사
domains/offsec/vendor/ch015/hooks/**        ← 무수정 복사
```

## F6. `Options.agent` 는 플러그인 에이전트를 해석하지 않는다 — 조용히 폴백한다

메인 스레드를 도메인 리드로 직접 띄우려고 `agent: 'nunchi-offsec:offsec-lead'` 와
bare `'offsec-lead'` 를 모두 시험했다. 둘 다 **에러 없이** 기본 페르소나로 폴백했고
(모델이 `ROLE: Claude` 라고 답했다) 훅 입력에 `agent_type` 이 실리지 않았다.

`sdk.d.ts:1336` 의 "`agents` 옵션이나 settings 에 정의돼 있어야 한다"는 문자 그대로다 —
플러그인 제공 에이전트는 위임(`Agent` 도구) 경로에서만 유효하다. 실패가 조용하므로
`entryAgent` 를 쓸 때는 훅에서 `agent_type` 관측으로 확인해야 한다.

## F7. 헤드리스에서 기본 권한 모드는 워커를 멈춘다

`permissionMode` 를 지정하지 않으면 워커의 도구 호출이 자동 거부되고
(`sdk.d.ts:4166` 의 headless-agent auto-deny) 워커는 그 거부를 "사용자가 개입했다"로
오해해 작업을 중단한다. 실제로 리드가 그렇게 멈췄다.

`permissionMode: 'bypassPermissions'` 로 프롬프트만 통과시켜도 방어선은 남는다.
실증: 그 상태에서 verifier 가 범위 밖 `find` 를 시도했고 벤더
`hooks/verify-invariants.js` 가 차단해 engagement `audit.log` 에
`VERIFIER_BASH_SCOPE_VIOLATION` 을 남겼다. 즉 권한 프롬프트를 끄는 것과
도메인 게이트를 끄는 것은 별개다.

## F8. 백그라운드 위임은 세션을 죽인다

`Agent` 도구는 위임을 백그라운드 작업으로 띄울 수 있다. 그 경우 메인 스레드가
바로 턴을 끝내고 세션이 종료되어, 서브에이전트가 도구를 한 번도 호출하지 못한 채
진단이 유실된다. 원장에 `SubagentStart` 만 있고 그 에이전트의 `PreToolUse` 가
없으면 이 상태다. 메인 스레드 프롬프트에서 완료 대기를 명시해야 한다.

## F9. 이식한 페르소나는 대화형 승인자를 전제한다

ch015 리드는 실행 전 계획 승인을 사람에게 요청한다. 헤드리스에는 승인자가 없어
그대로 교착된다. 미션 프롬프트에 자율 실행 조건을 넣고, **위임 지시문 안에도 같은
조건을 실어 내려보내야** 한다 (`src/runtime/missions/assess.ts` 의 `AUTONOMY`).

## F10. engagement 디렉토리는 프롬프트로 내려보내야 한다 — 아니면 게이트가 교착한다

벤더 게이트는 `AGENT_ENGAGEMENT_DIR` 기준으로 I1/I2(반앵커링)를 검사한다. verifier 가
VA 보고서를 읽으려면 그 디렉토리에 자율 판정 산출물 `02a_verify_autonomous-<round>.md`
가 먼저 있어야 한다.

환경변수만 설정하고 프롬프트로 알려주지 않으면 에이전트는 다른 경로에 쓰고, 게이트는
영원히 충족되지 않는다. 실측: `ANCHORING_VIOLATION` 4회가 쌓이는 동안 verifier 는
같은 Read 를 반복 시도하고 15분간 산출물이 0개였다. 게이트는 정상 작동했고
호스트의 계약 전달이 빠진 것이다.

`src/runtime/missions/assess.ts` 의 `buildEngagementContract()` 가 이 계약을 싣는다.
새 도메인을 붙일 때 같은 것을 잊으면 같은 방식으로 교착한다.

## 이식 제약 (F1~F4에서 따라오는 것)

1. 도메인 하나 = 로컬 플러그인 하나. 훅 매니페스트는 `hooks/hooks.json`,
   커맨드 경로는 `${CLAUDE_PLUGIN_ROOT}/vendor/ch015/hooks/*.js`.
2. 벤더 트리는 **무수정**. `lib/core/platform.js`가
   `PLUGIN_ROOT = CLAUDE_PLUGIN_ROOT`, `getSkillPath = <root>/skills/ch015/...`
   를 쓰므로 스킬 트리도 `skills/ch015/` 이름을 유지해야 한다. 이름을 바꾸면
   12.6k 줄을 건드려야 한다 — 바꾸지 않는다.
3. 외부 의존성은 `js-yaml` 하나. tree-sitter 18개는 AST 모드 전용이므로 초기
   이식에서 제외한다.
4. 에이전트는 `agents/` 평면에 둔다. `agents/offsec/`에 두면 이름이
   `nunchi-offsec:offsec:va-auditor`로 중복된다.
