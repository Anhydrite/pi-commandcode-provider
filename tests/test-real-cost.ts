/**
 * Behaviour tests for the real-cost mode: its default, and the precedence
 * between the saved setting and the environment variable.
 *
 * Real billed cost is the DEFAULT: every request routes through
 * `/alpha/generate` so `provider-metadata` reports what the gateway actually
 * charged (peak pricing included). No local rate card exists, so `usage.cost`
 * stays zero — and pi shows no cost — until the gateway reports an amount.
 * An explicit `commandcodeRealCost: false` in settings (written by
 * `/commandcode-realcost off`) opts out and stays opted out across restarts.
 *
 * Precedence:
 *   1. a boolean `commandcodeRealCost` in ~/.pi/agent/settings.json
 *   2. `COMMANDCODE_REAL_COST` (1/true/yes/on → ON, 0/false/no/off → OFF)
 *   3. DEFAULT: ON
 *
 * `src/real-cost.ts` resolves its settings path at module load, so
 * `PI_CODING_AGENT_DIR` is pointed at a temp dir before the dynamic import.
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

const agentDir = await mkdtemp(join(tmpdir(), "pi-cc-real-cost-"))
process.env.PI_CODING_AGENT_DIR = agentDir
delete process.env.COMMANDCODE_REAL_COST

const { loadRealCostEnabled, saveRealCostEnabled } = await import("../src/real-cost.ts")

const SETTINGS_PATH = join(agentDir, "settings.json")
const SETTINGS_KEY = "commandcodeRealCost"

async function resetSettings(contents?: string): Promise<void> {
  await rm(SETTINGS_PATH, { force: true })
  if (contents !== undefined) await writeFile(SETTINGS_PATH, contents, "utf-8")
}

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf-8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Clear both inputs so the documented default applies. */
async function clearInputs(): Promise<void> {
  await resetSettings()
  delete process.env.COMMANDCODE_REAL_COST
}

describe("real cost mode — default", () => {
  it("is ON when no setting is saved and no env var is set", async () => {
    await clearInputs()
    assert.equal(
      await loadRealCostEnabled(),
      true,
      "without an explicit opt-out the real billed cost must be recorded",
    )
  })

  it("is ON when COMMANDCODE_REAL_COST is empty", async () => {
    await clearInputs()
    process.env.COMMANDCODE_REAL_COST = ""
    assert.equal(await loadRealCostEnabled(), true)
  })

  it("is ON when COMMANDCODE_REAL_COST holds an unrecognized value", async () => {
    await clearInputs()
    process.env.COMMANDCODE_REAL_COST = "banana"
    assert.equal(await loadRealCostEnabled(), true)
  })
})

describe("real cost mode — COMMANDCODE_REAL_COST parsing", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on", "On"]) {
    it(`treats ${JSON.stringify(value)} as ON`, async () => {
      await clearInputs()
      process.env.COMMANDCODE_REAL_COST = value
      assert.equal(await loadRealCostEnabled(), true)
    })
  }

  for (const value of ["0", "false", "FALSE", " no ", "off", "Off"]) {
    it(`treats ${JSON.stringify(value)} as OFF`, async () => {
      await clearInputs()
      process.env.COMMANDCODE_REAL_COST = value
      assert.equal(await loadRealCostEnabled(), false)
    })
  }
})

describe("real cost mode — saved setting wins", () => {
  it("honours a saved OFF even when the env var asks for ON", async () => {
    await resetSettings(JSON.stringify({ [SETTINGS_KEY]: false }))
    process.env.COMMANDCODE_REAL_COST = "1"
    assert.equal(await loadRealCostEnabled(), false)
  })

  it("honours a saved ON even when the env var asks for OFF", async () => {
    await resetSettings(JSON.stringify({ [SETTINGS_KEY]: true }))
    process.env.COMMANDCODE_REAL_COST = "0"
    assert.equal(await loadRealCostEnabled(), true)
  })

  it("ignores a non-boolean saved value and falls back to the env var", async () => {
    await resetSettings(JSON.stringify({ [SETTINGS_KEY]: "yes" }))
    process.env.COMMANDCODE_REAL_COST = "0"
    assert.equal(await loadRealCostEnabled(), false)
  })
})

describe("real cost mode — persistence", () => {
  it("persists an opt-out under commandcodeRealCost", async () => {
    await clearInputs()
    await saveRealCostEnabled(false)
    assert.equal((await readSettings())[SETTINGS_KEY], false)
    assert.equal(await loadRealCostEnabled(), false)
  })

  it("persists an opt-in and keeps unrelated settings intact", async () => {
    await resetSettings(JSON.stringify({ theme: "dark", [SETTINGS_KEY]: false }))
    await saveRealCostEnabled(true)
    const settings = await readSettings()
    assert.equal(settings[SETTINGS_KEY], true)
    assert.equal(settings.theme, "dark", "unrelated settings must survive the write")
    assert.equal(await loadRealCostEnabled(), true)
  })

  it("keeps the opt-out sticky across a reload with the env var set to ON", async () => {
    await clearInputs()
    await saveRealCostEnabled(false)
    process.env.COMMANDCODE_REAL_COST = "1"
    assert.equal(await loadRealCostEnabled(), false)
  })
})
