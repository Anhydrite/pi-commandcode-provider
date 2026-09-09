import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createCommandCodeTransportRouter } from "../src/transport.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  StreamOptions,
} from "../src/types.ts"
import { collectEvents, createTestEventStream, makeContext, makeModel } from "./helpers.ts"

function completedStream(text: string): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const model = makeModel()
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  }
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: message },
    { type: "text_start", contentIndex: 0, partial: message },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "text_end", contentIndex: 0, content: text, partial: message },
    { type: "done", reason: "stop", message },
  ]
  for (const event of events) stream.push(event)
  stream.end()
  return stream
}

function providerStream(
  response: Response,
  text: string,
  options?: StreamOptions,
): AssistantMessageEventStreamLike {
  const stream = createTestEventStream()
  const run = async () => {
    const received = await (options?.fetch ?? fetch)("https://provider.test", {})
    await options?.onResponse?.(
      { status: received.status, headers: {} },
      makeModel({ api: "openai-completions" }),
    )
    const source = completedStream(text)
    for await (const event of source) stream.push(event)
    stream.end()
  }
  run().catch(() => stream.end())
  return stream
}

describe("Command Code transport router", () => {
  it("keeps using the Provider API after a successful request", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response("ok", { status: 200 }), "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
    }
    const first = await collectEvents(router.stream(makeModel(), makeContext(), options))
    const second = await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(first.at(-1)?.type, "done")
    assert.equal(second.at(-1)?.type, "done")
    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 2)
    assert.equal(generateCalls, 0)
  })

  it("falls back only for 403 upgrade_required and remembers generate", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const responseBody = JSON.stringify({
      error: { code: "upgrade_required", type: "permission_error" },
    })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response(responseBody, { status: 403 }), "blocked", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response(responseBody, { status: 403 })),
    }

    const first = await collectEvents(router.stream(makeModel(), makeContext(), options))
    const second = await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(first.at(-1)?.type, "done")
    assert.equal(second.at(-1)?.type, "done")
    assert.equal(router.getTransport(), "generate")
    assert.equal(providerCalls, 1)
    assert.equal(generateCalls, 2)
  })

  it("re-detects the transport after the API key changes", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const upgradeBody = JSON.stringify({ error: { code: "upgrade_required" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        const response =
          options?.apiKey === "go-key"
            ? new Response(upgradeBody, { status: 403 })
            : new Response("ok", { status: 200 })
        return providerStream(response, "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "go-key",
        fetch: () => Promise.resolve(new Response(upgradeBody, { status: 403 })),
      }),
    )
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )

    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 2)
    assert.equal(generateCalls, 1)
  })

  it("does not let a stale request overwrite the transport for a new API key", async () => {
    let releaseGoRequest: (() => void) | undefined
    const goRequestGate = new Promise<void>((resolve) => {
      releaseGoRequest = resolve
    })
    let providerCalls = 0
    let generateCalls = 0
    const upgradeBody = JSON.stringify({ error: { code: "upgrade_required" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        const response =
          options?.apiKey === "go-key"
            ? new Response(upgradeBody, { status: 403 })
            : new Response("ok", { status: 200 })
        const stream = createTestEventStream()
        const run = async () => {
          if (options?.apiKey === "go-key") await goRequestGate
          const received = await (options?.fetch ?? fetch)("https://provider.test", {})
          await options?.onResponse?.(
            { status: received.status, headers: {} },
            makeModel({ api: "openai-completions" }),
          )
          if (response.ok) {
            for await (const event of completedStream("provider")) stream.push(event)
          }
          stream.end()
        }
        run().catch(() => stream.end())
        return stream
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })

    const staleGoRequest = collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "go-key",
        fetch: () => Promise.resolve(new Response(upgradeBody, { status: 403 })),
      }),
    )
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )
    releaseGoRequest?.()
    await staleGoRequest
    await collectEvents(
      router.stream(makeModel(), makeContext(), {
        apiKey: "provider-key",
        fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
      }),
    )

    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 3)
    assert.equal(generateCalls, 1)
  })

  it("does not fall back for other 403 errors", async () => {
    let generateCalls = 0
    const responseBody = JSON.stringify({ error: { code: "permission_denied" } })
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) =>
        providerStream(new Response(responseBody, { status: 403 }), "blocked", options),
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response(responseBody, { status: 403 })),
    }

    await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(router.getTransport(), "provider")
    assert.equal(generateCalls, 0)
  })
})

describe("Command Code transport router — real-cost mode (preferGenerate)", () => {
  function errorOnlyStream(message: string): AssistantMessageEventStreamLike {
    const stream = createTestEventStream()
    const model = makeModel()
    stream.push({
      type: "error",
      reason: "error",
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
    })
    stream.end()
    return stream
  }

  it("routes every model through generate when preferGenerate is set", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response("ok", { status: 200 }), "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        return completedStream("generate")
      },
      preferGenerate: true,
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
    }

    const events = await collectEvents(
      router.stream(makeModel({ id: "claude-sonnet-5" }), makeContext(), options),
    )

    assert.equal(events.at(-1)?.type, "done")
    assert.equal(router.getTransport(), "generate")
    assert.equal(generateCalls, 1)
    assert.equal(providerCalls, 0, "generate must be preferred over a working Provider API")
  })

  it("falls back to the Provider API when generate fails before any content", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response("ok", { status: 200 }), "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        // Image input (or a plan/permission error): generate errors before any
        // content is streamed.
        return errorOnlyStream("image input is not supported by the generate transport")
      },
      preferGenerate: true,
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
    }

    const events = await collectEvents(router.stream(makeModel(), makeContext(), options))

    const done = events.at(-1)
    assert.equal(done?.type, "done")
    assert.equal(router.getTransport(), "provider")
    assert.equal(providerCalls, 1)
    assert.equal(generateCalls, 1)
    if (done?.type !== "done") throw new Error("expected done")
    const text = done.message.content[0]?.type === "text" ? done.message.content[0].text : ""
    assert.equal(text, "provider")
  })

  it("does not fall back after content already streamed by generate", async () => {
    let providerCalls = 0
    let generateCalls = 0
    const router = createCommandCodeTransportRouter({
      createStream: createTestEventStream,
      streamProvider: (_model, _context, options) => {
        providerCalls += 1
        return providerStream(new Response("ok", { status: 200 }), "provider", options)
      },
      streamGenerate: () => {
        generateCalls += 1
        // Mid-stream upstream failure after partial content: must surface as an
        // error, not silently replay the turn through the Provider API.
        const stream = createTestEventStream()
        const model = makeModel()
        const partial = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "partial" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        }
        stream.push({ type: "start", partial })
        stream.push({ type: "text_start", contentIndex: 0, partial })
        stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial })
        stream.push({ type: "text_end", contentIndex: 0, content: "partial", partial })
        stream.push({
          type: "error",
          reason: "error",
          error: { ...partial, content: [], stopReason: "error", errorMessage: "upstream died" },
        })
        stream.end()
        return stream
      },
      preferGenerate: true,
    })
    const options: StreamOptions = {
      fetch: () => Promise.resolve(new Response("ok", { status: 200 })),
    }

    const events = await collectEvents(router.stream(makeModel(), makeContext(), options))

    assert.equal(events.at(-1)?.type, "error")
    assert.equal(providerCalls, 0, "no fallback after content was already delivered")
  })
})
