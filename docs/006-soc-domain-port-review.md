# SOC domain port and independent review record

> **이전 기록 — 2026-09-18 현행화 메모.** 본문의 설계·명령·경로·수치와 완료 표시는 작성 당시 기록이며 현재 지원 범위를 보장하지 않는다.
> 현재 상태: [개발 현황](../../docs/development-status.ko.md) · [현재 실행 안내](../README.md)

- Date: 2026-08-04
- Contracts: `nunchi.soc.report@1.0.0`, `nunchi.soc.investigation@1.0.0`
- Release level: read-only sealed-snapshot simulator plus prepared-snapshot CLI
- Readiness: offline snapshot path is verified; live source authentication, tenant isolation, and operational actions are not production-ready.

## Contract and ownership result

SOC reuses the common `WorkflowContract` structure and host invariants proven by OffSec, but does not copy OffSec domain policy. Report and Investigation own separate contract, source schema registry, result schema registry, agents, methods, and skill. Only the common contract primitives and schema generator pattern are shared.

The host owns authorization, tenant and actor identity, mission and phase order, query plans and bounds, source collection, receipt validation, snapshot sealing, exact phase read sets, output validation, run state, and artifact creation. Model roles receive `Read` only and cannot browse, query a source, write, publish, create a case, notify, block, isolate, or execute a response action.

Every contract resource is SHA-256 pinned. Cached contracts and role resources are revalidated before use, so changes to an agent, skill, method, or generated schema fail closed until the mission contract digest is updated.

## Evidence and reliability controls

- Evidence review runs before candidate judgment or analysis is visible, reducing first-narrative anchoring.
- The prepared snapshot carries half-open UTC time bounds, provider version, query receipts, record and aggregate lineage, coverage, classification, and an immutable content hash.
- Every claim references existing locators and includes typed assertions that the host checks against exact record or aggregate fields. Multiple fields on one locator are supported, and every cited locator requires at least one assertion.
- The verifier reviews every claim, Investigation hypothesis, and advisory action exactly once against the candidate's exact locator and counterevidence sets. Unsupported, uncertain, incomplete-coverage, unresolved, or disproportionate output cannot receive a passing host gate.
- Advisory actions are limited to typed non-operational categories. The rendered draft displays hypotheses, prerequisites, alternatives, counterevidence, evidence-first bias risks, limitations, data-quality notes, all-phase unresolved reasons, and verifier decisions instead of presenting a single unqualified narrative.
- Source metadata, compact evidence, and prior model natural-language fields are screened before entering a later model phase. Instruction-like, multiline, secret-like, operational-completion, and unsupported compliance assertions fail closed.
- Report and Investigation contracts are selected by `(domain, mission)`; ambiguous SOC resolution is rejected.

## Independent audit disposition

Two separate read-only sessions reviewed contract integrity and model-reliability risks. Their findings led to host-side revalidation after source collection, exact phase artifact sets, resource-cache revalidation, non-vacuous claim/review arrays, lineage and time-bound checks, preservation of prior unresolved concerns, typed evidence assertions, exact action review, debiasing fields in the draft, provider metadata screening, phase-output screening, and separation of the renderer to satisfy static limits.

The reviews also reproduced the semantic residual below. The implementation therefore labels the output an internal draft and does not describe it as semantically proven, calibrated, or production-ready.

## Context-contamination assessment

SOC sessions inherit the existing isolation baseline: no filesystem setting sources, strict MCP configuration, disabled auto-memory, strict role skills, default-deny network policy, no delegation, and phase-scoped exact file allow-lists. Snapshot and prior-model strings are treated as untrusted data and checked before persistence or onward use.

These controls reduce ambient, cross-domain, source-to-model, and model-to-model contamination. They do not establish that all obfuscated or context-dependent instructions will be detected. A production connector should quarantine opaque raw events and pass a trusted typed projection rather than discard operationally relevant injection evidence.

## Verified boundary and residual limits

- Typed assertions prove only that cited scalar fields match the sealed snapshot. They do not prove that an arbitrary natural-language claim is entailed by those fields. External use requires a labeled adversarial evaluation set and a human or independently calibrated semantic gate.
- Evidence-first separation reduces anchoring, but all phases currently share one configured model. Same-model correlated error, repeated-run variance, cross-model disagreement, Brier/ECE calibration, and live provider quality were not measured.
- Instruction and secret checks are conservative string safety nets, not a contextual classifier or production DLP attestation. The prepared snapshot now requires a typed redaction receipt, but receipt presence is not itself proof that an external source redacted correctly.
- `FileRunStateStore` remains a local single-process fixture boundary. The PostgreSQL state/lease/fencing and transactional artifact/outbox path has a local integration test, while production polling, shared artifact storage, migration ownership, outbox consumers, and deployment test infrastructure remain platform inputs.
- The static/simulator `SocSourceAdapter` and offline prepared-snapshot CLI were exercised. Live source authentication, source-side tenant isolation, source pagination/rate limits, schema evolution, and source truthfulness remain unverified.
- A valid zero-result source must return a query receipt and a zero-count aggregate. Missing aggregates fail closed rather than allowing a vacuous claim path.
- Partial coverage intentionally produces `HOLD`. Whether a future internal investigation surface may show separately qualified partial observations is a product-policy decision.
- No publication, case mutation, notification, containment, WAF, or other operational action is implemented or authorized.

## Verification

`pnpm test:all` completed with exit code 0. The TypeScript/Vitest layer passed 24 files and 151 tests, and the vendor OffSec suite also completed. Focused SOC contract, source, mission, domain, session, and provider tests passed. `asx review` passed for the SOC schemas, source boundary, contract loader, artifact validator, renderer, domain adapter, mission, generator, and SOC test files. `git diff --check` passed.

One independent full-suite run transiently failed an existing OffSec `agent-wrapper` shared-log assertion; its isolated rerun, vendor rerun, and subsequent complete `pnpm test:all` runs passed. It was not reproduced as an SOC regression, but it remains a test-isolation signal rather than being silently omitted.
