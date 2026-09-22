import { denialContinuation, normalizeAskedEvent, normalizeRepliedEvent } from "./context.ts"
import { parseConfig } from "./config.ts"
import { describeError, writeDiagnostic } from "./diagnostics.ts"
import { releasedV2Runtime } from "./stable.ts"
import type { PermissionRequest, RuntimeContext } from "./types.ts"

type Handler = (event: unknown) => void

/**
 * Structural view of the OpenCode 2.x server plugin context. Declared locally
 * because the published SDK types lag the runtime (for example the permission
 * reply field is `decision` at runtime but `reply` in the types), and because
 * ownership is decided by probing these members rather than by version alone.
 */
export interface ServerPluginContext {
  readonly app?: { version?: string }
  readonly options: Readonly<Record<string, unknown>>
  readonly location: { directory: string; workspaceID?: string }
  readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> }
  readonly permission: {
    list(input: { sessionID: string }): Promise<unknown>
    reply(input: {
      sessionID: string
      requestID: string
      decision: "once" | "always" | "reject"
      message?: string
    }): Promise<unknown>
  }
  readonly session: {
    create(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
    get(input: { sessionID: string }): Promise<unknown>
    context(input: { sessionID: string }): Promise<unknown>
    generate(input: { sessionID: string; prompt: string }, options?: { signal?: AbortSignal }): Promise<unknown>
    interrupt(input: { sessionID: string }): Promise<unknown>
    prompt(input: Record<string, unknown>): Promise<unknown>
  }
}

const REQUIRED_CAPABILITIES = [
  "event.subscribe",
  "permission.list",
  "permission.reply",
  "session.create",
  "session.get",
  "session.context",
  "session.generate",
  "session.prompt",
] as const

const RUNNING_STARTED = new Set(["session.execution.started"])
const RUNNING_ENDED = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.cancelled",
  "session.execution.ended",
  "session.idle",
])
const RESUBSCRIBE_DELAY_MS = 1_000

/** Names the server context members the reviewer relies on, for diagnostics. */
export function serverReviewCapabilities(context: unknown): string[] {
  const value = context as Record<string, any> | undefined
  const present: string[] = []
  const probe = (name: string, fn: unknown) => {
    if (typeof fn === "function") present.push(name)
  }
  probe("event.subscribe", value?.event?.subscribe)
  probe("permission.list", value?.permission?.list)
  probe("permission.reply", value?.permission?.reply)
  probe("session.create", value?.session?.create)
  probe("session.get", value?.session?.get)
  probe("session.context", value?.session?.context)
  probe("session.generate", value?.session?.generate)
  probe("session.interrupt", value?.session?.interrupt)
  probe("session.prompt", value?.session?.prompt)
  return present
}

/**
 * The server owns V2 review only on released 2.x runtimes whose context has
 * every member the reviewer needs. Betas keep TUI ownership so the two sides
 * never both answer; the TUI applies the same version predicate.
 */
export function canOwnServerReview(capabilities: readonly string[], version: string | undefined): boolean {
  if (!releasedV2Runtime(version)) return false
  return REQUIRED_CAPABILITIES.every((capability) => capabilities.includes(capability))
}

export interface ServerRuntime {
  runtime: RuntimeContext
  /**
   * Marks a reply the reviewer is about to send. The server sees its own
   * `permission.replied` before the reply call returns, which would otherwise
   * cancel the review that produced it. Returns a release for a failed reply.
   */
  expectOwnReply(requestID: string): () => void
  dispose(): void
}

export function createServerRuntime(context: ServerPluginContext): ServerRuntime {
  const config = parseConfig(context.options)
  const listeners = new Map<string, Set<Handler>>()
  const sessions = new Map<string, { id: string; parentID?: string }>()
  const messages = new Map<string, unknown[]>()
  const pending = new Map<string, PermissionRequest>()
  const running = new Set<string>()
  const ownReplies = new Set<string>()
  const controller = new AbortController()

  const on = (type: string, handler: Handler) => {
    const handlers = listeners.get(type) ?? new Set<Handler>()
    handlers.add(handler)
    listeners.set(type, handlers)
    return () => handlers.delete(handler)
  }

  const dispatch = (type: string, event: unknown) => {
    for (const handler of listeners.get(type) ?? []) handler(event)
  }

  const handle = (event: unknown) => {
    if (!isRecord(event) || typeof event.type !== "string") return
    // The event stream is shared by every project instance in the server;
    // only the instance whose location raised the request may answer it.
    const directory = isRecord(event.location) ? event.location.directory : undefined
    if (typeof directory === "string" && directory !== context.location.directory) return
    const data = isRecord(event.data) ? event.data : undefined
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined

    if (RUNNING_STARTED.has(event.type) && sessionID) running.add(sessionID)
    if (RUNNING_ENDED.has(event.type) && sessionID) running.delete(sessionID)
    if (event.type === "session.deleted" && sessionID) {
      sessions.delete(sessionID)
      messages.delete(sessionID)
      running.delete(sessionID)
    }

    const asked = normalizeAskedEvent(event)
    if (asked) {
      pending.set(asked.id, asked)
      dispatch("permission.asked", event)
      return
    }
    const replied = normalizeRepliedEvent(event)
    if (replied) {
      pending.delete(replied.requestID)
      if (ownReplies.delete(replied.requestID)) return
      dispatch("permission.replied", event)
    }
  }

  const pump = async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of context.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) return
          handle(event)
        }
      } catch (error) {
        if (controller.signal.aborted) return
        writeDiagnostic(config.diagnosticsPath, {
          timestamp: new Date().toISOString(),
          event: "event_stream_restarted",
          errorMessage: describeError(error).message,
        })
      }
      if (controller.signal.aborted) return
      writeDiagnostic(config.diagnosticsPath, { timestamp: new Date().toISOString(), event: "event_stream_restarted" })
      await delay(RESUBSCRIBE_DELAY_MS, controller.signal)
    }
  }
  void pump()

  const root = async (sessionID: string) => {
    const seen = new Set<string>()
    let current = sessionID
    while (!seen.has(current)) {
      seen.add(current)
      let session = sessions.get(current)
      if (!session) {
        const result = unwrap(await context.session.get({ sessionID: current }).catch(() => undefined))
        if (!isRecord(result) || typeof result.id !== "string") return sessionID
        session = {
          id: result.id,
          ...(typeof result.parentID === "string" ? { parentID: result.parentID } : {}),
        }
        sessions.set(current, session)
      }
      if (!session.parentID) return current
      current = session.parentID
    }
    return sessionID
  }

  const syncMessages = async (sessionID: string) => {
    const result = unwrap(await context.session.context({ sessionID }))
    messages.set(sessionID, Array.isArray(result) ? result : [])
  }

  const syncPermissions = async (sessionID: string) => {
    const result = unwrap(await context.permission.list({ sessionID }))
    if (!Array.isArray(result)) return
    for (const [id, request] of pending) {
      if (request.sessionID === sessionID) pending.delete(id)
    }
    for (const value of result) {
      const request = normalizeAskedEvent({ type: "permission.asked", data: value })
      if (request) pending.set(request.id, request)
    }
  }

  const resume = async (sessionID: string, reason: string) => {
    const text = denialContinuation(reason)
    const delivery = running.has(sessionID) ? "steer" : "queue"
    try {
      await context.session.prompt({ sessionID, text, delivery })
      writeResume(config.diagnosticsPath, sessionID, delivery)
    } catch (error) {
      if (delivery === "queue") {
        writeResumeFailed(config.diagnosticsPath, sessionID, error)
        return
      }
      try {
        await context.session.prompt({ sessionID, text, delivery: "queue" })
        writeResume(config.diagnosticsPath, sessionID, "queue")
      } catch (fallbackError) {
        writeResumeFailed(config.diagnosticsPath, sessionID, fallbackError)
      }
    }
  }

  const runtime: RuntimeContext = {
    options: context.options,
    client: context,
    data: {
      on,
      session: {
        root,
        get: (sessionID) => sessions.get(sessionID),
        message: {
          list: (sessionID) => messages.get(sessionID) ?? [],
          get: (sessionID, messageID) =>
            (messages.get(sessionID) ?? []).find((message) => messageIDOf(message) === messageID),
          sync: syncMessages,
        },
        permission: {
          list: (sessionID) => [...pending.values()].filter((request) => request.sessionID === sessionID),
          sync: async (sessionID) => syncPermissions(sessionID).catch(() => undefined),
        },
      },
      location: { default: () => context.location },
    },
    location: context.location,
    resumeAfterDenial(sessionID, reason) {
      void resume(sessionID, reason)
    },
  }

  return {
    runtime,
    expectOwnReply(requestID) {
      ownReplies.add(requestID)
      return () => ownReplies.delete(requestID)
    },
    dispose() {
      controller.abort("plugin disposed")
      listeners.clear()
      sessions.clear()
      messages.clear()
      pending.clear()
      running.clear()
      ownReplies.clear()
    },
  }
}

function writeResume(path: string | undefined, sessionID: string, delivery: "steer" | "queue"): void {
  writeDiagnostic(path, { timestamp: new Date().toISOString(), sessionID, event: "resumed", delivery })
}

function writeResumeFailed(path: string | undefined, sessionID: string, error: unknown): void {
  writeDiagnostic(path, {
    timestamp: new Date().toISOString(),
    sessionID,
    event: "resume_failed",
    errorMessage: describeError(error).message,
  })
}

function messageIDOf(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined
  if (typeof message.id === "string") return message.id
  return isRecord(message.info) && typeof message.info.id === "string" ? message.info.id : undefined
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function unwrap(result: unknown): unknown {
  let value = result
  for (let depth = 0; depth < 3 && isRecord(value) && "data" in value; depth++) value = value.data
  return value
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
