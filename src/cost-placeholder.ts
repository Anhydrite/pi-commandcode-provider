/**
 * Cost placeholder for the generate transport.
 *
 * Command Code bills each request and reports the amount in the trailing
 * `provider-metadata` event (`inputInferenceCost` / `outputInferenceCost`).
 * That report is the ONLY cost source: the extension ships no rate card, so an
 * offline or opted-out request must stay at zero instead of showing an estimate
 * that can be wrong (the removed table billed DeepSeek V4 Flash at its stale
 * off-peak rate even during the 2x peak windows).
 *
 * The generate reader calls this on `finish`, before `provider-metadata`
 * arrives; it therefore must not invent anything.
 */

import type { Usage } from "./types.ts"

export function calculateCommandCodeCostPlaceholder(usage: Usage): void {
  usage.cost.input = 0
  usage.cost.output = 0
  usage.cost.cacheRead = 0
  usage.cost.cacheWrite = 0
  usage.cost.total = 0
}
