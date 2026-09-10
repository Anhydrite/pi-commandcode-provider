---
name: refresh-model-catalog
description: Use when adding or removing Command Code models or refreshing the model catalog snapshot (image, reasoning, effort, output-limit metadata) and its test fixtures in pi-commandcode-provider.
---

# Refresh Model Catalog

Use this skill whenever the Command Code model catalog changes: new or retired models, changed reasoning efforts, or output limits. All commands run from the repository root and work on Windows and Linux.

## Core rules

- Do not commit, tag, push, or publish unless the user explicitly asks in the current conversation.
- Never add pricing here. The extension ships no rate card; billed amounts come from the gateway (`provider-metadata`). See the “Cost” section of [README.md](../../../README.md). A local table is not an option: it drifts from the billed amount.
- Keep the change focused: one refresh per PR, no unrelated refactors.
- Follow [CONTRIBUTING.md](../../../CONTRIBUTING.md) for commit message rules.

## Workflow

### 1. Detect drift

```sh
npm run check:commandcode-catalog
```

This compares the repository snapshot against the latest published `command-code` npm package and reports added/removed models, changed efforts, and version drift. Use the report to scope the work.

### 2. Sync static model metadata

```sh
npm run sync:commandcode-catalog
```

Regenerates `src/commandcode-catalog.ts` and bumps the documented CLI version in `README.md`. Review the diff; the catalog also lists reasoning models without selectable efforts.

Never add efforts to the generated file by hand. Manual effort policy for reasoning models that upstream ships without levels lives in `src/commandcode-catalog-overrides.ts` and is merged at load time. When the sync report lists a model from that file under "New effort metadata", remove its override; `tests/test-models.ts` fails until you do.

### 3. Refresh the test fixtures

```sh
node .agents/skills/refresh-model-catalog/scripts/refresh-model-ids.mjs
```

The script snapshots the live model-id list into `tests/fixtures/commandcode-model-ids.json`.
There is no pricing fixture: `tests/test-no-static-pricing.ts` fails if a local price table
or fixture is reintroduced.

### 4. Update test expectations

Adjust the model-specific assertions that the refresh invalidated, typically in:

- `tests/test-models.ts`: image/reasoning/effort/output-limit assertions and catalog entry counts.

Do not weaken assertions to make them pass; update them to the verified upstream values.

### 5. Validate

```sh
npm run test:models
npm run test:no-static-pricing
npm run typecheck
npm run format:check
git diff --check
```

Run the full `npm test` before reporting the work as done when the environment allows it.

### 6. Document

Add entries to the `Unreleased` section of `CHANGELOG.md` covering new/retired models and effort changes.
