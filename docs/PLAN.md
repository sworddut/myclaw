# Myclaw Product Plan & Acceptance

## Goal

Deliver core coding-agent capability first, then optimize stability/performance:
- Stage 1: functional completeness for common coding workflows.
- Stage 2: ecosystem extensibility (MCP/Skills).
- Stage 3: persistence and advanced governance.

## Principles

- Feature first, optimization second.
- Each stage must have clear acceptance gates.
- No release without measurable checks.

## Milestones

### M1 (v0.3.x): Async Soft-Gate Checks + User Profile (High Priority, Done)

#### Scope
- Add non-blocking checks right after mutation (`write_file` / `apply_patch`).
- Add cross-session stable user profile and inject concise hints into context.
- Keep existing runtime and event loop stable.

#### Delivered
- Async check pipeline wired on `write_completed`.
- JS syntax checker (`node --check`) and Python syntax checker (`python3 -m py_compile`).
- Optional ESLint checker (enabled only when local `eslint.config.*` exists).
- Failure reports injected as `tool_result` to enable self-fix.
- Stable user profile stored at `~/.myclaw/user-profile.json` and updated on high-value signals.

#### Acceptance Status
- Build/test: pass.
- Manual verification: pass on JS/Python syntax error scenarios.
- Check pipeline trigger: enabled on mutation completion path.
- Runtime behavior: soft-gate non-blocking path verified.
- Session/metrics observability: check/profile events persisted.

#### Remaining for M1 hardening
- Error fingerprint dedupe for repeated identical check failures.
- Max injection cap per turn/session to reduce noise.
- `/profile show|set|unset|reset` user controls.

### M2 (v0.4.0): MCP + Skill Support (Medium Priority)

#### Scope
- MCP client integration for external tool providers.
- Skill loading and execution contract for reusable workflows.

#### Deliverables
- MCP registry/config with endpoint routing.
- Skill discovery + execution in runtime tool chain.
- Permission/safety alignment for MCP/Skill actions.

#### Acceptance
- At least 2 MCP tools + 2 skills integrated in sample flow.
- End-to-end success rate >= 90% for defined demo tasks.
- No increase in critical runtime errors vs M1 baseline.

### M3 (v0.5.x+): SQL Persistence + Active Oscillation Governance (Long-term)

#### Scope
- SQL-backed session/memory storage and replay analytics.
- Upgrade oscillation handling from observation to intervention.

#### Deliverables
- Storage abstraction (`InMemory` + `SQL`) with migration path.
- Query APIs for replay/debug/metrics.
- Oscillation policy engine (cooldown, strategy-switch hint, loop breaker).

#### Acceptance
- Resume correctness >= 99% on replay test set.
- Query latency p95 under target (define per environment).
- Oscillation repeat ratio reduced by >= 30% on benchmark prompts.

## Cross-cutting Gates (Every Release)

- `npm run build` and `npm test` pass.
- Tag/version consistency check passes (`vX.Y.Z` == `package.json.version`).
- Release notes/changelog updated.
- Smoke tests:
  - read -> tool call -> tool result -> final response
  - session end logs flushed (`session_end`, `metrics_summary`)
  - timeout/retry behavior validated.

## Metrics to Track

- Runtime:
  - model request latency (p50/p95)
  - tool success/error rate
  - timeout/retry count
- Quality:
  - pre-write check fail rate
  - auto-fix success rate
- Stability:
  - repeat ratio
  - novelty ratio
  - no-mutation streak
  - oscillation alert count

## Risks & Mitigation

- Over-blocking checks hurt usability:
  - Start with observe mode, enforce per-project opt-in.
- Provider compatibility drift:
  - Keep fallback path and add compatibility tests.
- Logging overhead:
  - Keep async subscribers + flush on shutdown.
- Scope creep:
  - Freeze milestone scope after kickoff.

## Execution Cadence

- Weekly: milestone health review (progress + metrics + blockers).
- Per PR: checklist against current milestone acceptance.
- Per release: publish summary with achieved metrics and known gaps.
