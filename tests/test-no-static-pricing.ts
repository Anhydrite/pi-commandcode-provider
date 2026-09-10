/**
 * Guard: this extension never fabricates a price.
 *
 * Command Code publishes no per-model prices through its API, and the static
 * rate card that used to live in `src/pricing.ts` drifted from the real bill
 * (it held a stale off-peak DeepSeek V4 Flash rate while the gateway billed 2x
 * during peak hours). Real billed cost is now the only cost source — the
 * gateway's `provider-metadata` event — and everything else must stay at zero
 * (pi renders a zero cost as "no cost" rather than a made-up figure).
 *
 * These tests fail if a local price table or a local cost estimate comes back.
 */

import assert from "node:assert/strict"
import { access } from "node:fs/promises"
import { describe, it } from "node:test"

import { calculateCommandCodeCostPlaceholder } from "../src/cost-placeholder.ts"
import type { Usage } from "../src/types.ts"

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 12_345,
    output: 678,
    cacheRead: 9_012,
    cacheWrite: 34,
    totalTokens: 22_069,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  }
}

describe("no static pricing", () => {
  it("leaves usage.cost at zero until the gateway reports what it billed", () => {
    const subject = usage()
    calculateCommandCodeCostPlaceholder(subject)
    assert.deepEqual(subject.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
  })

  it("never derives a cost from token counts", () => {
    const huge = usage({ input: 4_000_000, output: 1_000_000, cacheRead: 8_000_000 })
    calculateCommandCodeCostPlaceholder(huge)
    assert.equal(huge.cost.total, 0, "token counts must not imply a price")
  })

  it("has no local rate card to import", async () => {
    // The static table was deleted on purpose. A silent re-introduction (for
    // example by restoring it from git history) must fail this suite.
    // The specifier is held in a variable so this file still typechecks while
    // the module is absent.
    const removedModule = "../src/pricing.ts"
    await assert.rejects(
      import(removedModule),
      /Cannot find module|Failed to resolve|ERR_MODULE_NOT_FOUND/,
      "src/pricing.ts must not exist: prices come from the gateway, not from a table",
    )
  })

  it("has no pricing fixture snapshot", async () => {
    await assert.rejects(
      access(new URL("./fixtures/commandcode-pricing.json", import.meta.url)),
      "tests/fixtures/commandcode-pricing.json must not exist",
    )
  })
})
