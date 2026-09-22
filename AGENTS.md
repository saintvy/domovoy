# Domovoy — Agent Instructions

This file defines repository-wide instructions for coding agents working on Domovoy.

## 1. Project purpose

Domovoy is a serverless household-finance application for recurring obligations, payments, refunds, credit, shared responsibility, and multicurrency accounting.

The project values:

- correctness of financial history over convenience;
- explicit, auditable state transitions;
- deterministic and idempotent processing;
- strict family isolation and server-side authorization;
- low standing AWS cost;
- a browser-independent backend for scheduled work;
- preservation of existing deployed contracts.

Do not treat Domovoy as a generic expense tracker or bank-integration product unless the task explicitly changes product scope.

## 2. Read before changing code

For any non-trivial change, inspect these files first:

1. `README.md`
2. `docs/product-specification.md`
3. `docs/architecture.md`
4. `docs/verification.md`
5. `CONTRIBUTING.md`
6. relevant source and tests in the area being modified

The product specification defines required behavior. The implementation is evidence of current behavior, not permission to contradict the specification silently.

If code, tests, and documentation disagree, surface the conflict before choosing a direction.

## 3. Repository map

- `src/domain/` — framework-independent billing, payment, money, recurrence, lifecycle, and validation rules
- `src/client/` — React UI, authentication, drafts, PWA behavior, reports
- `src/aws/` — Family API, PostgreSQL persistence, authorization, backups, scheduled services, workers
- `src/server/` — portable server-side utilities such as backup encryption
- `infra/` — AWS CDK stacks, deployment checks, database provisioning
- `scripts/` — local PostgreSQL/API/development tooling
- `tests/`, `e2e/` — unit, integration, scale, infrastructure, and browser tests
- `docs/` — product, architecture, deployment, development, and operations documentation

Prefer extending the existing layer that owns a responsibility instead of introducing a parallel abstraction.

## 4. Architecture invariants

Unless the user explicitly approves an architectural change, preserve these constraints:

- PostgreSQL remains the source of confirmed household state.
- Financial rules remain framework-independent in the domain layer.
- Browser execution is not required for scheduled server work.
- The production Family API runs in isolated application subnets.
- The existing PostgreSQL 16 RDS instance is reused through cross-account VPC peering.
- Do not introduce a NAT Gateway solely to let a private Lambda call a public API.
- Do not introduce an always-on application server when a serverless component is sufficient.
- Public/external workers should not receive SQL access without a strong, explicit reason.
- Secrets must not enter Git, public runtime configuration, logs, or client bundles.
- Authorization is enforced server-side; never trust family IDs, roles, or actor identity supplied by the browser.
- Preserve transactional command handling, revision checks, and idempotency receipts.
- Preserve existing `brownie_*`, `X-Brownie-Session`, stack names, and other compatibility identifiers unless a migration plan is part of the task.

Treat cost as an architectural constraint, not an afterthought.

## 5. Data and accounting invariants

Agents must preserve the existing accounting model unless the task explicitly changes it.

Important distinctions include:

- obligations are not payments;
- automatic payment records are accounting assumptions, not bank transactions;
- charges, payments, allocations, refunds, unused credit, and waivers are separate concepts;
- settlement, timing, and certainty are independent derived dimensions;
- money uses integer minor units;
- original amounts/currencies must be preserved;
- deterministic IDs and durable receipts prevent duplicate processing;
- household accounting dates use the household timezone; technical timestamps use UTC.

Never silently convert an estimate into a confirmed amount or an automatic assumption into external payment confirmation.

## 6. Concurrency and idempotency

Assume that:

- requests can be retried;
- Lambda/EventBridge/SQS delivery can be duplicated;
- a timeout can occur after a successful external side effect;
- multiple devices can edit the same family;
- scheduled processing can overlap or restart.

For every new write path, explicitly answer:

1. What is the logical operation identifier?
2. What prevents duplicate state changes?
3. What happens if the process dies after the side effect but before acknowledgement?
4. What is retried, and which retries are safe?
5. Is the transaction boundary correct?
6. Can stale state overwrite newer state?

Do not rely on "this normally runs once."

## 7. External integrations

For public APIs such as Telegram:

- keep database-facing compute private;
- prefer an outbox/queue/event handoff to an internet-capable worker rather than adding NAT to the Family API;
- give public workers the minimum data required for delivery;
- do not give external workers SQL credentials by default;
- keep provider tokens in an appropriate secrets service;
- design for provider timeouts, duplicate delivery, throttling, and partial failure;
- distinguish "queued", "attempted", "provider accepted", and "confirmed by the application" where those states matter.

For inbound webhooks, authenticate the provider request and make handling replay-safe.

## 8. Multi-agent workflow

Codex automatically discovers the complete project-scoped custom-agent definitions
in `.codex/agents/`. Each TOML file is the single source of truth for that role:

- `orchestrator` — Astra/medium technical lead for decomposition and integration;
- `architect` — Astra/medium read-only architecture and contract design;
- `developer` — Sol/medium implementation of clear, bounded, low-risk slices;
- `developer_high_effort` — Sol/high implementation for complex, ambiguous, or
  high-risk slices;
- `reviewer` — Sol/high independent read-only review.

When spawning a custom agent, select it by the `name` declared in its TOML file
and give it a bounded task brief. Do not maintain parallel role handbooks outside
`.codex/agents/`; role behavior belongs in `developer_instructions` in the TOML.

The primary agent normally acts as the orchestrator and owns the task plan and
integration result. Use the `orchestrator` custom agent only when the user explicitly
requests that role or a parent agent delegates a complete, bounded sub-workflow;
do not spawn it merely to mirror the primary agent.

Use subagents only when the work can be separated by clear contracts or when independent review materially reduces risk. Do not create subagents merely to imitate a human organization.

### Developer routing

Use `developer` only when **all** of the following are true:

- the contract and acceptance criteria are explicit and stable;
- the slice is local or isolated and has no unresolved cross-layer design;
- it does not change financial/accounting semantics, authorization, family
  isolation, persistence transactions, schema/migrations, concurrency,
  idempotency, retries, scheduled processing, or external side effects;
- it does not introduce or materially change AWS resources, IAM, networking,
  secrets, trust boundaries, or deployment ordering;
- expected failure modes and focused tests are straightforward.

Typical `developer` work includes presentational UI under an established pattern,
copy/i18n, documentation, deterministic test additions, mechanical type propagation,
and small refactors with unchanged behavior.

Use `developer_high_effort` if **any** of the following is true:

- the task touches money, billing lifecycle, timezone/accounting dates, payments,
  refunds, credit, waivers, or other financial history;
- it touches authentication, authorization, family isolation, sessions, linking
  tokens, secrets, or an external trust boundary;
- it changes PostgreSQL persistence, migrations, transaction boundaries, revision
  checks, concurrency, idempotency, retries, queues/outboxes, scheduled work, or
  provider calls;
- it changes infrastructure, IAM, networking, deployment/migration order, or spans
  multiple architectural layers;
- requirements, contracts, failure semantics, or the correct test strategy remain
  ambiguous after repository inspection;
- a failed implementation could corrupt history, leak data, duplicate side effects,
  break production deployment, or be difficult to roll back.

When classification is uncertain, use `developer_high_effort`. Reduce uncertainty
first by inspecting the repository and freezing contracts; do not route to
`developer` merely to save tokens. Different developers may run in parallel only
for non-overlapping slices with frozen interfaces.

For a cross-cutting change that adds an external integration, scheduled processing,
infrastructure, persistence, authorization, or financial behavior, the primary
agent must use the orchestrated workflow below unless the user explicitly asks for
a single-agent workflow or the task is only a small, local edit. Delegation is not
permission to broaden scope: the primary agent remains responsible for user-facing
updates, integration, validation, and the final answer.

Recommended flow for a cross-cutting feature:

1. Orchestrator establishes scope and acceptance criteria.
2. Architect inspects the repository and proposes component boundaries/contracts.
3. Orchestrator freezes the interfaces that independent tasks depend on.
4. Developers implement independent slices with non-overlapping file ownership;
   use separate worktrees/branches only when the orchestrator explicitly creates
   and assigns them.
5. Reviewer evaluates the integrated diff independently.
6. The appropriately routed Developer fixes findings.
7. Orchestrator verifies the complete acceptance criteria and test evidence.

Run architecture before implementation when shared contracts are not yet stable.
Parallelize only independent, non-overlapping work after those contracts are frozen.
The primary/orchestrating agent must wait for requested subagents, reconcile their
results, and ensure that material reviewer findings are fixed or explicitly rejected
with a technical reason.

## 9. Change discipline

Before editing:

- inspect the exact code path;
- search for existing helpers, naming patterns, tests, and compatibility behavior;
- identify the smallest coherent change.

While editing:

- avoid unrelated refactors;
- avoid speculative abstractions;
- keep public contracts stable unless change is required;
- update types, tests, infrastructure, and docs together when the behavior spans them;
- never weaken a test simply to make a change pass.

After editing:

- inspect the final diff;
- remove dead code and debugging output;
- verify no secret or environment-specific identifier was committed;
- run the smallest relevant checks, then broader checks appropriate to the change.

## 10. Standard verification

Baseline repository checks:

```bash
npm run format:check
npm run build
npm run test:quick
```

Use additional suites when the changed area requires them:

```bash
npm run test:scale
npm run test:e2e
npm run test:pwa
npm run deploy:check
```

Infrastructure changes should normally include `npm run deploy:check`.

Browser behavior changes should normally include the relevant Playwright suite.

Persistence, authorization, or scheduled-processing changes require focused tests for failure and retry behavior, not only happy-path tests.

If a required test cannot be run, state exactly why and what remains unverified.

## 11. Definition of done

A task is not complete merely because code compiles.

For a non-trivial feature, completion means:

- requested behavior is implemented;
- domain and architectural invariants are preserved;
- authorization is correct;
- duplicate/retry behavior is defined;
- failure behavior is defined;
- tests cover the risky paths;
- relevant documentation is updated;
- infrastructure changes synthesize successfully where applicable;
- the final diff contains no unrelated changes;
- the handoff states what changed, what was tested, and any remaining risks.

## 12. Current reminder-feature guidance

When implementing Telegram reminders, prefer this responsibility split unless repository evidence justifies a better design:

- scheduled/private component determines which reminders are due;
- durable state/outbox records the logical notification;
- an asynchronous handoff transports delivery work;
- an internet-capable Telegram worker calls the Telegram Bot API;
- Telegram delivery code does not become a second financial domain model;
- user actions such as "Paid" must ultimately use authorized Domovoy server commands rather than mutating accounting state inside the bot worker.

The exact AWS primitive (for example SQS versus an existing S3 outbox pattern) is a design decision. Do not add infrastructure only because it is fashionable; justify it against reliability, cost, operational complexity, and existing project patterns.
