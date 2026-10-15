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
import { join } from "node:path"

const SETTINGS_KEY = "commandcodeRealCost"

const TRUTHY = new Set(["1", "true", "yes", "on"])
const FALSY = new Set(["0", "false", "no", "off"])

/**
 * Settings file that holds the toggle, inside the host's agent directory.
 *
 * The caller passes `getAgentDir()` from pi rather than this module reading
 * `PI_CODING_AGENT_DIR` itself: the host already resolved that directory, it
 * honours a configured override the provider should not second-guess, and the
 * provider has no business reading undocumented host variables.
 */
function settingsPath(agentDir: string): string {
  return join(agentDir, "settings.json")
}

async function readSettingsFile(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function writeSettingsFile(path: string, data: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8")
}

/** Parse `COMMANDCODE_REAL_COST`; null when it does not express a preference. */
export function realCostFromEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const normalized = value.trim().toLowerCase()
  if (TRUTHY.has(normalized)) return true
  if (FALSY.has(normalized)) return false
  return null
}

export async function loadRealCostEnabled(agentDir: string): Promise<boolean> {
  const settings = await readSettingsFile(settingsPath(agentDir))
  const saved = settings[SETTINGS_KEY]
  if (typeof saved === "boolean") return saved
  return realCostFromEnv(process.env.COMMANDCODE_REAL_COST) ?? true
}

export async function saveRealCostEnabled(agentDir: string, enabled: boolean): Promise<void> {
  const path = settingsPath(agentDir)
  const settings = await readSettingsFile(path)
  settings[SETTINGS_KEY] = enabled
  await writeSettingsFile(path, settings)
}
