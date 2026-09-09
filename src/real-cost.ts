/**
 * Runtime toggle for the real-cost mode (generate transport).
 *
 * State precedence:
 *   1. the persisted setting `commandcodeRealCost` in ~/.pi/agent/settings.json
 *      (toggled by /commandcode-realcost),
 *   2. the COMMANDCODE_REAL_COST=1 environment variable as the initial default
 *      when no setting is saved (handy for headless runs / tests).
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

export async function loadRealCostEnabled(): Promise<boolean> {
  const settings = await readSettingsFile()
  const saved = settings[SETTINGS_KEY]
  if (typeof saved === "boolean") return saved
  return process.env.COMMANDCODE_REAL_COST === "1"
}

export async function saveRealCostEnabled(enabled: boolean): Promise<void> {
  const settings = await readSettingsFile()
  settings[SETTINGS_KEY] = enabled
  await writeSettingsFile(settings)
}
