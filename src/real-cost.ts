/**
 * Real-cost mode: route every request through `/alpha/generate` so the real
 * billed cost reported by the gateway (`provider-metadata`) is recorded instead
 * of the local off-peak catalog estimate.
 *
 * Real cost is the DEFAULT. The mode is only disabled by an explicit opt-out:
 *
 *   1. the persisted setting `commandcodeRealCost` in ~/.pi/agent/settings.json
 *      (written by `/commandcode-realcost on|off`),
 *   2. otherwise `COMMANDCODE_REAL_COST` — `1`/`true`/`yes`/`on` enable,
 *      `0`/`false`/`no`/`off` disable (case/whitespace insensitive); an unset,
 *      empty, or unrecognized value falls through to the default,
 *   3. otherwise ON.
 *
 * The in-memory value rules the running session; toggling persists the new
 * value so it survives a pi restart.
 */

import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const SETTINGS_KEY = "commandcodeRealCost"
// pi resolves its agent dir from PI_CODING_AGENT_DIR, else ~/.pi/agent.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
const SETTINGS_PATH = join(AGENT_DIR, "settings.json")

const TRUTHY = new Set(["1", "true", "yes", "on"])
const FALSY = new Set(["0", "false", "no", "off"])

async function readSettingsFile(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8")
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function writeSettingsFile(data: Record<string, unknown>): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf-8")
}

/** Parse `COMMANDCODE_REAL_COST`; null when it does not express a preference. */
export function realCostFromEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const normalized = value.trim().toLowerCase()
  if (TRUTHY.has(normalized)) return true
  if (FALSY.has(normalized)) return false
  return null
}

export async function loadRealCostEnabled(): Promise<boolean> {
  const settings = await readSettingsFile()
  const saved = settings[SETTINGS_KEY]
  if (typeof saved === "boolean") return saved
  return realCostFromEnv(process.env.COMMANDCODE_REAL_COST) ?? true
}

export async function saveRealCostEnabled(enabled: boolean): Promise<void> {
  const settings = await readSettingsFile()
  settings[SETTINGS_KEY] = enabled
  await writeSettingsFile(settings)
}
