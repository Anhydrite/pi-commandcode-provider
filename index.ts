/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { pickCommandCodeApiKey, withResolvedCommandCodeApiKey } from "./src/converters.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCostPlaceholder } from "./src/cost-placeholder.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import { loadRealCostEnabled, saveRealCostEnabled } from "./src/real-cost.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { transcriptReadersFrom, withTranscriptPromptAndTools } from "./src/transcript.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"

const COMMAND_CODE_API = "commandcode-custom"

/**
 * Cost credited to a model before the gateway reports what it billed.
 *
 * Command Code publishes no per-model prices through its API (the provider
 * catalog carries ids and context windows only), and a hard-coded rate card
 * drifted from the real bill (it billed DeepSeek V4 Flash at 2x during peak
 * hours while the table held a stale off-peak rate). So nothing is estimated:
 * every model is declared at zero cost and `usage.cost` is written exclusively
 * by the gateway's `provider-metadata` event. When that event never arrives the
 * cost stays zero, which pi renders as "no cost" rather than a made-up figure.
 */
const UNPRICED_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const
const COMPAT_SOURCE_ID = "pi-commandcode-provider"

type CompatStreamFunction = (
  model: Parameters<typeof streamNativeProvider>[0],
  context: Parameters<typeof streamNativeProvider>[1],
  options?: Parameters<typeof streamNativeProvider>[2],
) => AssistantMessageEventStream

/**
 * pi's compat entrypoint exposes `registerApiProvider`; Oh My Pi maps
 * `@earendil-works/pi-ai/compat` onto its own pi-ai, which lacks that export
 * and registers custom APIs itself inside `registerProvider`. Resolve the
 * function at runtime so the extension loads on both hosts.
 */
function compatApiProviderRegistrar(): ((...args: unknown[]) => unknown) | undefined {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function" ? (register as (...args: unknown[]) => unknown) : undefined
}

function registerCompatApiProvider(stream: CompatStreamFunction): void {
  compatApiProviderRegistrar()?.(
    { api: COMMAND_CODE_API, stream, streamSimple: stream },
    COMPAT_SOURCE_ID,
  )
}

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials and `--api-key` take over, and
 * the entry keeps the API-key auth method registered next to OAuth. Without
 * it pi composes an OAuth-only provider and drops stored `api_key`
 * credentials and `--api-key`.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and is sent verbatim as
 * `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit `apiKey` unless
 * a real key is configured; OMP then reads env keys and stored credentials
 * itself.
 *
 * Hosts are told apart by the same `registerApiProvider` probe used for the
 * compat registry: pi exports it, OMP does not.
 */
function providerApiKey(): string | undefined {
  const configured = pickCommandCodeApiKey(getConfiguredApiKey(), undefined)
  if (configured) return configured
  return compatApiProviderRegistrar() ? "$COMMAND_CODE_API_KEY" : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
): ProviderConfig {
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: providerApiKey(),
    api: COMMAND_CODE_API,
    streamSimple: streamCommandCode,
    headers,
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: COMMAND_CODE_API,
      baseUrl: baseUrlForModel(apiBase, model.api),
      reasoning: model.reasoning,
      ...(thinkingMetadataForModel(model.id) ?? {}),
      input: [...inputModalitiesForModel(model.id)],
      cost: UNPRICED_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers,
      compat:
        model.api === "openai-completions"
          ? {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
              maxTokensField: "max_tokens",
            }
          : {
              supportsEagerToolInputStreaming: false,
              supportsLongCacheRetention: false,
              supportsCacheControlOnTools: false,
              supportsToolReferences: false,
              ...(model.reasoning ? { forceAdaptiveThinking: true } : {}),
            },
    })),
  }
}

function legacyApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

export default async function (pi: ExtensionAPI) {
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  // Real billed cost is the default: route every request through
  // /alpha/generate so the API reports what it actually charged in
  // provider-metadata (peak/off-peak, gateway and model-specific rates).
  // `/commandcode-realcost off` (persisted) or COMMANDCODE_REAL_COST=0 opts out
  // and falls back to the Provider API's local off-peak catalog estimate.
  const realCost = { enabled: await loadRealCostEnabled() }
  // pi 0.86+ hands providers a TranscriptContext: the prompt and tool
  // declarations live in transcript system messages, and the top-level
  // `systemPrompt`/`tools` fields are undefined. The generate transport builds
  // its own request body, so it must replay them itself; otherwise the request
  // declares no tools and models write tool calls as plain text.
  const transcriptReaders = transcriptReadersFrom(piAiCompat)
  const streamGenerate = createStreamCommandCode({
    createStream: () => new AssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCostPlaceholder,
    apiBase: legacyApiBase(apiBase),
  })
  const resolveStreamOptions = (options?: Parameters<typeof streamNativeProvider>[2]) =>
    withResolvedCommandCodeApiKey(options, getConfiguredApiKey())
  const transport = createCommandCodeTransportRouter({
    createStream: () => new AssistantMessageEventStream(),
    streamProvider: (model, context, options) =>
      streamNativeProvider(
        { ...model, api: apiForModelId(model.id), compat: model.compatConfig ?? model.compat },
        context,
        resolveStreamOptions(options),
      ),
    streamGenerate: (model, context, options) =>
      streamGenerate(
        model,
        withTranscriptPromptAndTools(context, transcriptReaders),
        resolveStreamOptions(options),
      ),
    preferGenerate: () => realCost.enabled,
  })

  pi.registerCommand("commandcode-realcost", {
    description:
      "Toggle real billed request cost (default ON; routes all models through /alpha/generate)",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase()
      const next =
        arg === "on" || arg === "1" || arg === "true"
          ? true
          : arg === "off" || arg === "0" || arg === "false"
            ? false
            : !realCost.enabled
      realCost.enabled = next
      await saveRealCostEnabled(next)
      await ctx.waitForIdle?.()
      ctx.ui.notify(
        next
          ? "Real request cost ON: every request now routes through /alpha/generate and records its real billed cost (peak/off-peak included)."
          : "Real request cost OFF: the Provider API is preferred and costs are local off-peak estimates again. Run /commandcode-realcost on to restore the real billed cost.",
        "info",
      )
    },
  })

  // pi dispatches the main chat through the registered provider, but sibling
  // extensions that call `streamSimple` from `@earendil-works/pi-ai/compat`
  // with a Command Code model resolve `model.api` through the compat
  // api-registry, which knows nothing about extension providers. Register the
  // custom api there so those calls reach the same transport. The registry
  // resolves no credentials for extension providers, so fall back to the
  // configured key when the caller passes none or a placeholder.
  const compatStream: CompatStreamFunction = (model, context, options) =>
    transport.stream(model, context, resolveStreamOptions(options)) as AssistantMessageEventStream
  registerCompatApiProvider(compatStream)

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  registerCommandCodeQuota(pi, {
    apiBase: legacyApiBase(apiBase),
    headers: commandCodeHeaders(),
  })

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: (signal) =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
        signal,
      }),
    loadCachedModels: () => loadCachedCommandCodeModels(modelsCachePath),
    createProviderConfig: (models) => createProviderConfig(models, apiBase, transport.stream),
    getTransport: transport.getTransport,
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
