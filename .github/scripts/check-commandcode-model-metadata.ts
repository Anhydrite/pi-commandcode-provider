import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import ts from "typescript"

import {
  COMMAND_CODE_CLI_VERSION,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
  MODEL_MAX_OUTPUT_TOKENS,
  MODEL_REASONING,
} from "../../src/commandcode-catalog.ts"

const execFileAsync = promisify(execFile)
const MODELS_REFERENCE_PATH = "dist/bundled/command-code-knowledge/reference/models.md"
const CLI_BUNDLE_PATH = "dist/cli.mjs"
const VALID_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

function quoteWindowsArgument(argument: string): string {
  if (argument.length === 0) return '""'
  if (!/[\s"]/.test(argument)) return argument
  return `"${argument.replaceAll('"', '\\"')}"`
}

/**
 * Run npm on Windows and POSIX. npm is a `.cmd` shim on Windows, which
 * execFile cannot spawn directly, so route it through the shell there with
 * shell-safe quoting.
 */
function execNpmFileAsync(
  args: readonly string[],
  options: { cwd: string; encoding: "utf-8"; maxBuffer?: number },
): Promise<{ stdout: string }> {
  if (process.platform !== "win32") return execFileAsync("npm", args, options)
  const command = ["npm", ...args.map(quoteWindowsArgument)].join(" ")
  return execFileAsync(command, { ...options, shell: true })
}
const CATALOG_SOURCE_PATH = new URL("../../src/commandcode-catalog.ts", import.meta.url)
const README_PATH = new URL("../../README.md", import.meta.url)
const OVERRIDES_SOURCE_PATH = new URL("../../src/commandcode-catalog-overrides.ts", import.meta.url)

export interface CommandCodeModelMetadata {
  imageModelIds: readonly string[]
  reasoningModelIds: readonly string[]
  reasoningEfforts: Readonly<Record<string, readonly string[]>>
  maxOutputTokens: Readonly<Record<string, number>>
}

export interface ModelMetadataDiff {
  versionChanged: boolean
  addedImageModelIds: readonly string[]
  removedImageModelIds: readonly string[]
  addedReasoningModelIds: readonly string[]
  removedReasoningModelIds: readonly string[]
  addedEffortModelIds: readonly string[]
  removedEffortModelIds: readonly string[]
  changedEffortModelIds: readonly string[]
  addedMaxOutputModelIds: readonly string[]
  removedMaxOutputModelIds: readonly string[]
  changedMaxOutputModelIds: readonly string[]
}

interface PackedPackage {
  filename: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function parsePackedPackage(value: unknown): PackedPackage {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error("Expected npm pack to return one package")
  }

  const filename = value[0].filename
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("Expected npm pack to return a tarball filename")
  }

  return { filename }
}

export function parsePackageVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value)) {
    throw new Error("Expected npm view to return one semantic version")
  }
  return value
}

export function parseModelsReference(markdown: string): {
  modelIds: readonly string[]
  reasoningEfforts: Readonly<Record<string, readonly string[]>>
} {
  const modelIds = new Set<string>()
  const reasoningEfforts: Record<string, readonly string[]> = {}

  for (const line of markdown.split("\n")) {
    const match = /^\| `([^`]+)` \| [^|]* \| [^|]* \| ([^|]*) \|/.exec(line)
    if (!match) continue

    const modelId = match[1]
    const effortsColumn = match[2]?.trim()
    if (!modelId || !effortsColumn) throw new Error(`Could not parse model row: ${line}`)
    if (modelIds.has(modelId)) throw new Error(`Duplicate model id in reference: ${modelId}`)
    modelIds.add(modelId)

    if (effortsColumn === "—") continue

    const efforts = effortsColumn.split(",").map((effort) => effort.trim())
    if (efforts.length === 0 || efforts.some((effort) => !VALID_EFFORTS.has(effort))) {
      throw new Error(`Unexpected reasoning efforts for ${modelId}: ${effortsColumn}`)
    }
    reasoningEfforts[modelId] = efforts
  }

  if (modelIds.size === 0) throw new Error("No model rows found in Command Code reference")

  return {
    modelIds: sorted(modelIds),
    reasoningEfforts: Object.fromEntries(
      Object.entries(reasoningEfforts).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

/**
 * Slice the object literal that starts at `start` (a `{`) and return it whole.
 *
 * The bundle is minified JavaScript, so the embedded catalog is not JSON: keys
 * are unquoted and values use `!0`/`!1`. A depth counter that skips string
 * bodies is enough to delimit one entry, and every value the catalog uses is a
 * literal (`null`, `!0`, a number, a bare string, or a flat array literal).
 */
function objectLiteral(bundle: string, start: number): string {
  let depth = 0
  let quote = ""
  let escaped = false
  for (let index = start; index < bundle.length; index += 1) {
    const character = bundle[index] ?? ""
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) return bundle.slice(start, index + 1)
    }
  }

  throw new Error("Unterminated object literal in the Command Code CLI bundle")
}

/**
 * Fields a model entry contributes to the generated catalog. The CLI bundle is
 * minified, so values are literals: `null`, `!0`/`!1`, numbers, bare strings,
 * or flat array literals.
 */
export interface EmbeddedModelEntry {
  inputModalities?: readonly string[]
  reasoning: boolean
  reasoningEfforts?: readonly string[]
  maxOutputTokens?: number
}

function objectLiteralAt(bundle: string, start: number): string {
  let depth = 0
  let quote = ""
  let escaped = false
  for (let index = start; index < bundle.length; index += 1) {
    const character = bundle[index] ?? ""
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) return bundle.slice(start, index + 1)
    }
  }

  throw new Error("Unterminated object literal in the Command Code CLI bundle")
}

function literalField(entry: string, field: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|[,{])${field}:("(?:[^"\\\\]|\\\\.)*"|null|!0|!1|[\\d.]+|\\[[^\\]]*\\])`,
  )
  return pattern.exec(entry)?.[1]
}

function stringList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value === "null") return undefined
  if (!value.startsWith("[") || !value.endsWith("]")) return undefined
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.startsWith('"') ? (JSON.parse(item) as string) : item))
}

/**
 * Derive per-model capabilities from the CLI bundle.
 *
 * Older CLI releases kept a bare text-only id set next to `isKnownTextOnlyModel`
 * and this script parsed a neighboring `new Set([...])` as JSON. Current bundles
 * turned that marker into a function reference and embed typed model entries
 * instead, so that parse now reads an unrelated set and dies. There is no anchor
 * guaranteed to survive such a refactor, so match on the model ids the reference
 * documentation already lists and read the entry that owns their capabilities.
 *
 * Every occurrence that owns `inputModalities` is merged, because the command
 * catalog and the registry map disagree: the command catalog lists selectable
 * efforts only (no `off`) and omits `reasoning` for models that reason without a
 * selectable level, while the registry marks them `reasoning:!0`. Merging keeps
 * a model that either source considers reasoning-capable instead of dropping the
 * flag for everything the command catalog under-documents.
 */
export function parseEmbeddedModelCatalog(
  bundle: string,
  modelIds: readonly string[],
): Readonly<Record<string, EmbeddedModelEntry>> {
  const catalog: Record<string, EmbeddedModelEntry> = {}

  for (const modelId of modelIds) {
    const needle = `id:${JSON.stringify(modelId)}`
    const entry: EmbeddedModelEntry = { reasoning: false }
    let found = false

    for (let from = 0; ; ) {
      const at = bundle.indexOf(needle, from)
      if (at < 0) break
      from = at + needle.length

      // The `id` also appears in an inner `display` record that owns only
      // presentation fields, so widen until an object owns the capabilities.
      let candidate = ""
      for (let start = bundle.lastIndexOf("{", at); start >= 0; ) {
        const enclosing = objectLiteralAt(bundle, start)
        if (enclosing.includes("inputModalities:")) {
          candidate = enclosing
          break
        }
        start = bundle.lastIndexOf("{", start - 1)
      }
      if (!candidate) continue

      const modalities = stringList(literalField(candidate, "inputModalities"))
      if (modalities) entry.inputModalities = modalities
      if (literalField(candidate, "reasoning") === "!0") entry.reasoning = true
      const efforts = stringList(literalField(candidate, "reasoningEfforts"))
      if (efforts && efforts.length > 0) {
        entry.reasoningEfforts = efforts
        entry.reasoning = true
      }
      const maxOutput = literalField(candidate, "maxOutputTokens")
      if (maxOutput !== undefined && maxOutput !== "null") {
        const value = Number(maxOutput)
        if (Number.isFinite(value) && value > 0) entry.maxOutputTokens = value
      }
      found = true
    }

    if (!found) throw new Error(`Could not find model metadata for ${modelId}`)
    catalog[modelId] = entry
  }

  if (Object.keys(catalog).length === 0) {
    throw new Error("No model metadata found in the Command Code CLI bundle")
  }

  return catalog
}

export function parseBundleModelCapabilities(
  bundle: string,
  modelIds: readonly string[],
): {
  imageModelIds: readonly string[]
  reasoningModelIds: readonly string[]
  maxOutputTokens: Readonly<Record<string, number>>
} {
  const catalog = parseEmbeddedModelCatalog(bundle, modelIds)
  const imageModelIds: string[] = []
  const reasoningModelIds: string[] = []
  const maxOutputTokens: Record<string, number> = {}

  for (const [modelId, entry] of Object.entries(catalog)) {
    if (entry.inputModalities?.includes("image")) imageModelIds.push(modelId)
    if (entry.reasoning) reasoningModelIds.push(modelId)
    if (entry.maxOutputTokens !== undefined) maxOutputTokens[modelId] = entry.maxOutputTokens
  }

  return {
    imageModelIds: sorted(imageModelIds),
    reasoningModelIds: sorted(reasoningModelIds),
    maxOutputTokens: Object.fromEntries(
      Object.entries(maxOutputTokens).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

export function commandCodeModelMetadataFromContents(
  modelsReference: string,
  cliBundle: string,
): CommandCodeModelMetadata {
  const reference = parseModelsReference(modelsReference)
  const capabilities = parseBundleModelCapabilities(cliBundle, reference.modelIds)

  return {
    imageModelIds: capabilities.imageModelIds,
    reasoningModelIds: capabilities.reasoningModelIds,
    reasoningEfforts: reference.reasoningEfforts,
    maxOutputTokens: capabilities.maxOutputTokens,
  }
}

export function currentModelMetadata(): CommandCodeModelMetadata {
  return {
    imageModelIds: sorted(Object.keys(MODEL_INPUT_MODALITIES)),
    reasoningModelIds: sorted(Object.keys(MODEL_REASONING)),
    reasoningEfforts: Object.fromEntries(
      Object.entries(MODEL_EFFORTS)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([modelId, efforts]) => [modelId, [...efforts]]),
    ),
    maxOutputTokens: Object.fromEntries(
      Object.entries(MODEL_MAX_OUTPUT_TOKENS).sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}

export function diffModelMetadata(
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
  currentVersion = COMMAND_CODE_CLI_VERSION,
  upstreamVersion = COMMAND_CODE_CLI_VERSION,
): ModelMetadataDiff {
  const currentImages = new Set(current.imageModelIds)
  const upstreamImages = new Set(upstream.imageModelIds)
  const currentReasoning = new Set(current.reasoningModelIds)
  const upstreamReasoning = new Set(upstream.reasoningModelIds)
  const currentEffortIds = Object.keys(current.reasoningEfforts)
  const upstreamEffortIds = Object.keys(upstream.reasoningEfforts)
  const currentEffortSet = new Set(currentEffortIds)
  const upstreamEffortSet = new Set(upstreamEffortIds)
  const currentMaxOutputIds = Object.keys(current.maxOutputTokens)
  const upstreamMaxOutputIds = Object.keys(upstream.maxOutputTokens)
  const currentMaxOutputSet = new Set(currentMaxOutputIds)
  const upstreamMaxOutputSet = new Set(upstreamMaxOutputIds)

  return {
    versionChanged: currentVersion !== upstreamVersion,
    addedImageModelIds: sorted(
      upstream.imageModelIds.filter((modelId) => !currentImages.has(modelId)),
    ),
    removedImageModelIds: sorted(
      current.imageModelIds.filter((modelId) => !upstreamImages.has(modelId)),
    ),
    addedReasoningModelIds: sorted(
      upstream.reasoningModelIds.filter((modelId) => !currentReasoning.has(modelId)),
    ),
    removedReasoningModelIds: sorted(
      current.reasoningModelIds.filter((modelId) => !upstreamReasoning.has(modelId)),
    ),
    addedEffortModelIds: sorted(
      upstreamEffortIds.filter((modelId) => !currentEffortSet.has(modelId)),
    ),
    removedEffortModelIds: sorted(
      currentEffortIds.filter((modelId) => !upstreamEffortSet.has(modelId)),
    ),
    changedEffortModelIds: sorted(
      upstreamEffortIds.filter(
        (modelId) =>
          currentEffortSet.has(modelId) &&
          JSON.stringify(current.reasoningEfforts[modelId]) !==
            JSON.stringify(upstream.reasoningEfforts[modelId]),
      ),
    ),
    addedMaxOutputModelIds: sorted(
      upstreamMaxOutputIds.filter((modelId) => !currentMaxOutputSet.has(modelId)),
    ),
    removedMaxOutputModelIds: sorted(
      currentMaxOutputIds.filter((modelId) => !upstreamMaxOutputSet.has(modelId)),
    ),
    changedMaxOutputModelIds: sorted(
      upstreamMaxOutputIds.filter(
        (modelId) =>
          currentMaxOutputSet.has(modelId) &&
          current.maxOutputTokens[modelId] !== upstream.maxOutputTokens[modelId],
      ),
    ),
  }
}

export function hasModelMetadataDiff(diff: ModelMetadataDiff): boolean {
  return (
    diff.versionChanged ||
    Object.entries(diff).some(([key, modelIds]) => key !== "versionChanged" && modelIds.length > 0)
  )
}

function formatList(modelIds: readonly string[]): string {
  return modelIds.length > 0 ? modelIds.map((modelId) => `\`${modelId}\``).join(", ") : "None"
}

function formatReasoningChanges(
  modelIds: readonly string[],
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
): string {
  if (modelIds.length === 0) return "None"
  return modelIds
    .map(
      (modelId) =>
        `\`${modelId}\`: \`${(current.reasoningEfforts[modelId] ?? []).join(", ")}\` → \`${(
          upstream.reasoningEfforts[modelId] ?? []
        ).join(", ")}\``,
    )
    .join("<br>")
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function recordEntries(
  values: Readonly<Record<string, readonly string[]>>,
): readonly [string, readonly string[]][] {
  return Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
}

export function renderCommandCodeCatalog(
  packageVersion: string,
  metadata: CommandCodeModelMetadata,
): string {
  const imageEntries = sorted(metadata.imageModelIds)
    .map((modelId) => `  ${quoted(modelId)}: ["text", "image"],`)
    .join("\n")
  const reasoningEntries = sorted(metadata.reasoningModelIds)
    .map((modelId) => `  ${quoted(modelId)}: true,`)
    .join("\n")
  const effortEntries = recordEntries(metadata.reasoningEfforts)
    .map(
      ([modelId, efforts]) =>
        `  ${quoted(modelId)}: [${efforts.map((effort) => quoted(effort)).join(", ")}],`,
    )
    .join("\n")
  const maxOutputEntries = Object.entries(metadata.maxOutputTokens)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([modelId, value]) =>
        `  ${quoted(modelId)}: ${value.toLocaleString("en-US").replaceAll(",", "_")},`,
    )
    .join("\n")

  return `export const COMMAND_CODE_CLI_VERSION = ${quoted(packageVersion)}\n\nexport type CommandCodeInputType = "text" | "image"\nexport type CommandCodeReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"\n\n/**\n * Generated from command-code@${packageVersion} by \`npm run sync:commandcode-catalog\`.\n * Do not edit manually.\n */\nexport const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputType[]>> = {\n${imageEntries}\n}\n\nexport const MODEL_REASONING: Readonly<Record<string, true>> = {\n${reasoningEntries}\n}\n\nexport const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {\n${effortEntries}\n}\n\nexport const MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {\n${maxOutputEntries}\n}\n`
}

function updateDocumentedCatalogVersion(
  contents: string,
  packageVersion: string,
  context: string,
): string {
  const pattern = /command-code@\d+\.\d+\.\d+(?:[-+][^`\s,]+)?/
  if (!pattern.test(contents)) throw new Error(`Could not find the ${context} catalog version`)
  return contents.replace(pattern, `command-code@${packageVersion}`)
}

/**
 * Drop manual effort overrides that upstream now publishes itself.
 *
 * `tests/test-models.ts` fails while an override duplicates upstream efforts, so
 * leaving the removal to a human kept the scheduled workflow red and blocked its
 * own pull request. The overrides file is hand-formatted, so this rewrites entries
 * and leaves comments, ordering, and still-needed entries untouched.
 */
export function pruneObsoleteEffortOverrides(
  contents: string,
  upstreamEffortModelIds: readonly string[],
): { contents: string; removedModelIds: readonly string[] } {
  const source = ts.createSourceFile("overrides.ts", contents, ts.ScriptTarget.Latest, true)
  const upstreamModelIds = new Set(upstreamEffortModelIds)
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "MODEL_EFFORT_OVERRIDES")
        continue
      const map = declaration.initializer
      if (!map || !ts.isObjectLiteralExpression(map)) {
        throw new Error("MODEL_EFFORT_OVERRIDES must be an object literal")
      }
      const obsolete = map.properties.filter(
        (property) =>
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.name) &&
          upstreamModelIds.has(property.name.text),
      )
      const removedModelIds = obsolete.flatMap((property) =>
        ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)
          ? [property.name.text]
          : [],
      )
      if (obsolete.length === 0) return { contents, removedModelIds }
      if (obsolete.length === map.properties.length) {
        return {
          contents: contents.slice(0, map.getStart(source)) + "{}" + contents.slice(map.end),
          removedModelIds: sorted(removedModelIds),
        }
      }
      // Only remove syntax spans, preserving comments and all neighboring declarations.
      let updated = contents
      for (const property of [...obsolete].reverse()) {
        const tokenStart = property.getStart(source)
        const lineStart = contents.lastIndexOf("\n", tokenStart - 1) + 1
        const start = /^\s*$/.test(contents.slice(lineStart, tokenStart)) ? lineStart : tokenStart
        const comma = /^\s*,/.exec(contents.slice(property.end, map.end))
        const tokenEnd = property.end + (comma?.[0].length ?? 0)
        const newline = /^[ \t]*\r?\n/.exec(contents.slice(tokenEnd))
        const end = tokenEnd + (newline?.[0].length ?? 0)
        updated = updated.slice(0, start) + updated.slice(end)
      }
      return { contents: updated, removedModelIds: sorted(removedModelIds) }
    }
  }
  return { contents, removedModelIds: [] }
}

export function updateReadmeCatalogVersion(readme: string, packageVersion: string): string {
  return updateDocumentedCatalogVersion(readme, packageVersion, "README")
}

async function writeSynchronizedCatalog(
  packageVersion: string,
  metadata: CommandCodeModelMetadata,
): Promise<readonly string[]> {
  const readme = await readFile(README_PATH, "utf-8")
  await Promise.all([
    writeFile(CATALOG_SOURCE_PATH, renderCommandCodeCatalog(packageVersion, metadata), "utf-8"),
    writeFile(README_PATH, updateReadmeCatalogVersion(readme, packageVersion), "utf-8"),
  ])

  const overrides = await readFile(OVERRIDES_SOURCE_PATH, "utf-8")
  const pruned = pruneObsoleteEffortOverrides(overrides, Object.keys(metadata.reasoningEfforts))
  if (pruned.removedModelIds.length > 0) {
    await writeFile(OVERRIDES_SOURCE_PATH, pruned.contents, "utf-8")
  }
  return pruned.removedModelIds
}

function metadataReport(
  packageVersion: string,
  current: CommandCodeModelMetadata,
  upstream: CommandCodeModelMetadata,
  diff: ModelMetadataDiff,
): string {
  const status = hasModelMetadataDiff(diff) ? "❌ Drift detected" : "✅ Metadata is current"
  return [
    "## Command Code static model metadata",
    "",
    `**${status}**`,
    "",
    `- Repository snapshot: \`command-code@${COMMAND_CODE_CLI_VERSION}\``,
    `- Inspected package: \`command-code@${packageVersion}\``,
    `- Image-capable models: ${current.imageModelIds.length} repository / ${upstream.imageModelIds.length} upstream`,
    `- Reasoning models: ${current.reasoningModelIds.length} repository / ${upstream.reasoningModelIds.length} upstream`,
    `- Models with selectable efforts: ${Object.keys(current.reasoningEfforts).length} repository / ${Object.keys(upstream.reasoningEfforts).length} upstream`,
    `- Model-specific output limits: ${Object.keys(current.maxOutputTokens).length} repository / ${Object.keys(upstream.maxOutputTokens).length} upstream`,
    "",
    "| Change | Models |",
    "| --- | --- |",
    `| CLI version | ${diff.versionChanged ? `\`${COMMAND_CODE_CLI_VERSION}\` → \`${packageVersion}\`` : "Current"} |`,
    `| New image support | ${formatList(diff.addedImageModelIds)} |`,
    `| Removed image support | ${formatList(diff.removedImageModelIds)} |`,
    `| New reasoning models | ${formatList(diff.addedReasoningModelIds)} |`,
    `| Removed reasoning models | ${formatList(diff.removedReasoningModelIds)} |`,
    `| New effort metadata | ${formatList(diff.addedEffortModelIds)} |`,
    `| Removed effort metadata | ${formatList(diff.removedEffortModelIds)} |`,
    `| Changed reasoning efforts | ${formatReasoningChanges(diff.changedEffortModelIds, current, upstream)} |`,
    `| New output limits | ${formatList(diff.addedMaxOutputModelIds)} |`,
    `| Removed output limits | ${formatList(diff.removedMaxOutputModelIds)} |`,
    `| Changed output limits | ${formatList(diff.changedMaxOutputModelIds)} |`,
    "",
  ].join("\n")
}

async function resolvePackageSpec(
  packageSpec: string,
  directory: string,
  npmCacheDirectory: string,
): Promise<string> {
  if (packageSpec !== "command-code@latest") return packageSpec

  const { stdout } = await execNpmFileAsync(
    ["view", packageSpec, "version", "--json", "--prefer-online", "--cache", npmCacheDirectory],
    {
      cwd: directory,
      encoding: "utf-8",
    },
  )
  return `command-code@${parsePackageVersion(JSON.parse(stdout) as unknown)}`
}

async function inspectPackedPackage(packageSpec: string): Promise<{
  packageVersion: string
  metadata: CommandCodeModelMetadata
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-commandcode-model-check-"))
  const npmCacheDirectory = join(directory, "npm-cache")

  try {
    const resolvedPackageSpec = await resolvePackageSpec(packageSpec, directory, npmCacheDirectory)
    const { stdout } = await execNpmFileAsync(
      ["pack", resolvedPackageSpec, "--json", "--prefer-online", "--cache", npmCacheDirectory],
      {
        cwd: directory,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
    )
    const packed = parsePackedPackage(JSON.parse(stdout) as unknown)
    await execFileAsync("tar", ["-xzf", packed.filename], { cwd: directory })

    const packageDirectory = join(directory, "package")
    const packageJsonContents = await readFile(join(packageDirectory, "package.json"), "utf-8")
    const packageJson: unknown = JSON.parse(packageJsonContents)
    if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
      throw new Error("Expected command-code package.json to contain a version")
    }

    const [modelsReference, cliBundle] = await Promise.all([
      readFile(join(packageDirectory, MODELS_REFERENCE_PATH), "utf-8"),
      readFile(join(packageDirectory, CLI_BUNDLE_PATH), "utf-8"),
    ])

    return {
      packageVersion: packageJson.version,
      metadata: commandCodeModelMetadataFromContents(modelsReference, cliBundle),
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write")
  const packageSpec =
    process.argv.find((argument) => argument.startsWith("command-code@")) ?? "command-code@latest"
  const current = currentModelMetadata()
  const upstreamPackage = await inspectPackedPackage(packageSpec)
  const diff = diffModelMetadata(
    current,
    upstreamPackage.metadata,
    COMMAND_CODE_CLI_VERSION,
    upstreamPackage.packageVersion,
  )
  const report = metadataReport(
    upstreamPackage.packageVersion,
    current,
    upstreamPackage.metadata,
    diff,
  )

  console.log(report)

  if (write) {
    const removedOverrides = await writeSynchronizedCatalog(
      upstreamPackage.packageVersion,
      upstreamPackage.metadata,
    )
    console.log(`Synchronized static metadata with command-code@${upstreamPackage.packageVersion}.`)
    if (removedOverrides.length > 0) {
      console.log(
        `Removed ${removedOverrides.length} manual effort override(s) now published upstream: ${removedOverrides.join(", ")}.`,
      )
    }
    return
  }

  if (hasModelMetadataDiff(diff)) {
    throw new Error(
      `Static model metadata differs from command-code@${upstreamPackage.packageVersion}. Update src/models.ts and the snapshot version.`,
    )
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url
}

if (isMainModule()) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  }
}
