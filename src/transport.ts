import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ContextLike,
  ErrorReason,
  ModelLike,
  StreamOptions,
} from "./types.ts"

export type CommandCodeTransport = "unknown" | "provider" | "generate"

interface TransportDependencies {
  createStream: () => AssistantMessageEventStreamLike
  streamProvider: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
  streamGenerate: (
    model: ModelLike,
    context: ContextLike,
    options?: StreamOptions,
  ) => AssistantMessageEventStreamLike
  /**
   * When true (or a function returning true), route every request through the
   * /alpha/generate transport first so the real billed cost returned in its
   * provider-metadata event is captured for ANY model (peak/off-peak, gateway
   * and model-specific rates included — nothing is estimated or hard-coded).
   * Generate is text-only, so a request that fails before producing any
   * content (for example image input) falls back to the Provider API for that
   * request. Defaults to false, which keeps the Provider API as the preferred
   * transport. A function is evaluated per request so the mode can be toggled
   * at runtime (e.g. via /commandcode-realcost).
   */
  preferGenerate?: boolean | (() => boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function isUpgradeRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false

  try {
    const body: unknown = await response.clone().json()
    if (!isRecord(body)) return false
    const error = isRecord(body.error) ? body.error : body
    return error.code === "upgrade_required"
  } catch {
    return false
  }
}

function errorEvent(model: ModelLike, error: unknown): AssistantMessageEvent {
  const message = error instanceof Error ? error.message : String(error)
  return {
    type: "error",
    reason: "error" as ErrorReason,
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  }
}

export function createCommandCodeTransportRouter(deps: TransportDependencies) {
  let transport: CommandCodeTransport = "unknown"
  let apiKey: string | undefined
  // Tracks the last preferGenerate value so a runtime toggle (which changes the
  // meaning of the transport memo) resets it like a credential change does.
  let lastPreferGenerate: boolean | undefined

  function preferGenerateNow(): boolean {
    const value = deps.preferGenerate
    return typeof value === "function" ? value() : value === true
  }

  function pipe(
    source: AssistantMessageEventStreamLike,
    target: AssistantMessageEventStreamLike,
  ): Promise<void> {
    return (async () => {
      for await (const event of source) target.push(event)
    })()
  }

  return {
    getTransport(): CommandCodeTransport {
      return transport
    },

    reset(): void {
      transport = "unknown"
      apiKey = undefined
      lastPreferGenerate = undefined
    },

    stream(
      model: ModelLike,
      context: ContextLike,
      options?: StreamOptions,
    ): AssistantMessageEventStreamLike {
      const preferGenerate = preferGenerateNow()
      if (options?.apiKey !== apiKey || preferGenerate !== lastPreferGenerate) {
        apiKey = options?.apiKey
        lastPreferGenerate = preferGenerate
        transport = "unknown"
      }
      const requestApiKey = options?.apiKey

      if (!preferGenerate) {
        // Default: Provider API first (OpenAI/Anthropic-compatible), falling
        // back to the legacy generate transport only on 403 upgrade_required
        // (Go-plan accounts).
        if (transport === "generate") return deps.streamGenerate(model, context, options)
        return streamProviderWithUpgradeFallback(model, context, options, requestApiKey)
      }

      // Real-cost mode: try generate first for every model so the request
      // carries its real billed cost; fall back to the Provider API only when
      // generate fails before producing any content.
      return streamGenerateWithProviderFallback(model, context, options, requestApiKey)
    },
  }

  function streamProviderWithUpgradeFallback(
    model: ModelLike,
    context: ContextLike,
    options: StreamOptions | undefined,
    requestApiKey: string | undefined,
  ): AssistantMessageEventStreamLike {
    const output = deps.createStream()
    let upgradeRequired = false
    const fetchImpl = options?.fetch ?? fetch
    const providerOptions: StreamOptions = {
      ...options,
      fetch: async (input, init) => {
        const response = await fetchImpl(input, init)
        if (await isUpgradeRequired(response)) upgradeRequired = true
        return response
      },
      onResponse: async (response, responseModel) => {
        if (upgradeRequired) return
        await options?.onResponse?.(response, responseModel)
      },
    }

    const run = async () => {
      const providerStream = deps.streamProvider(model, context, providerOptions)

      for await (const event of providerStream) {
        if (!upgradeRequired) {
          if (apiKey === requestApiKey) transport = "provider"
          output.push(event)
        }
      }

      if (upgradeRequired) {
        if (apiKey === requestApiKey) transport = "generate"
        await pipe(deps.streamGenerate(model, context, options), output)
      }
      output.end()
    }

    run().catch((error: unknown) => {
      output.push(errorEvent(model, error))
      output.end()
    })
    return output
  }

  function streamGenerateWithProviderFallback(
    model: ModelLike,
    context: ContextLike,
    options: StreamOptions | undefined,
    requestApiKey: string | undefined,
  ): AssistantMessageEventStreamLike {
    const output = deps.createStream()

    const run = async () => {
      const generateStream = deps.streamGenerate(model, context, options)
      // Buffer pre-content events so a terminal generate failure (e.g. image
      // input, which the text-only protocol rejects) can be discarded cleanly
      // before the Provider API takes over the request.
      const pending: AssistantMessageEvent[] = []
      let flushed = false
      let producedContent = false
      let fallbackToProvider = false

      const flush = () => {
        for (const event of pending) output.push(event)
        pending.length = 0
        flushed = true
      }

      for await (const event of generateStream) {
        if (event.type === "error") {
          if (!producedContent) {
            fallbackToProvider = true
            break
          }
          // Mid-stream failure after content: surface it as-is.
          flush()
          output.push(event)
          continue
        }
        if (event.type === "done") {
          if (apiKey === requestApiKey) transport = "generate"
          flush()
          output.push(event)
          continue
        }
        if (
          !producedContent &&
          (event.type === "text_start" ||
            event.type === "thinking_start" ||
            event.type === "toolcall_start")
        ) {
          producedContent = true
          flush()
        }
        if (flushed) output.push(event)
        else pending.push(event)
      }

      if (fallbackToProvider) {
        if (apiKey === requestApiKey) transport = "provider"
        await pipe(deps.streamProvider(model, context, options), output)
      }
      output.end()
    }

    run().catch((error: unknown) => {
      output.push(errorEvent(model, error))
      output.end()
    })
    return output
  }
}
