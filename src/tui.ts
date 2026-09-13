import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode-ai/plugin/tui/plugin"
import { AUTO_PERMISSIONS_MESSAGE_PREFIX } from "./context.ts"
import { parseConfig } from "./config.ts"
import { describeError, writeDiagnostic } from "./diagnostics.ts"
import { installReviewer } from "./reviewer.ts"
import { protocolForVersion } from "./stable.ts"
import type { RuntimeContext } from "./types.ts"

export const id = "opencode.auto-permissions"

const plugin = Plugin.define({
  id,
  setup(context) {
    return installReviewer(fromContext(context), { protocols: ["v2"] })
  },
})

/**
 * Minimal structural type for the transitional TUI plugin API used by older
 * betas and the stable v1 TUI. The current plugin package dropped these
 * declarations, so they are kept locally for the legacy entrypoint below.
 */
interface LegacyTuiState {
  session: {
    get(sessionID: string): { id: string; parentID?: string } | undefined
    messages(sessionID: string): Array<{ id: string }>
    permission(sessionID: string): unknown[]
  }
  part(messageID: string): unknown[]
  path: { directory: string }
}

interface LegacyTuiApi {
  client: unknown
  state: LegacyTuiState
  event: { on(type: string, handler: (event: unknown) => void): () => void }
  ui: { toast: (input: { title?: string; message: string; variant?: string; duration?: number }) => void }
  lifecycle: { onDispose(dispose: () => void): unknown }
}

type LegacyTuiPlugin = (api: LegacyTuiApi, options: Readonly<Record<string, unknown>> | undefined) => Promise<void>

export const tui: LegacyTuiPlugin = async (api, options) => {
  if (await isStableRuntime(api.client)) return
  const dispose = installReviewer(fromLegacyApi(api, options ?? {}), { protocols: ["v2"] })
  api.lifecycle.onDispose(dispose)
}

export default { ...plugin, tui }

function fromContext(context: Context): RuntimeContext {
  return {
    options: context.options,
    client: context.client,
    data: context.data as unknown as RuntimeContext["data"],
    ...(context.location ? { location: context.location } : {}),
    showToast(input) {
      context.ui.toast.show(input)
    },
    resumeAfterDenial(sessionID, reason) {
      void resumeV2Session(context, sessionID, reason)
    },
  }
}

/**
 * Writes the denial continuation into the main session so the coding agent
 * observes the block reason and keeps working. OpenCode V2 does not surface
 * the permission reject message to the agent on its own, so after replying we
 * admit a durable user prompt carrying the reason and safer-continuation
 * guidance. While the agent loop is still running the prompt is steered into
 * the active run so the feedback lands mid-turn; when the session has gone
 * idle it is admitted with resume so a fresh loop starts.
 */
async function resumeV2Session(context: Context, sessionID: string, reason: string): Promise<void> {
  const config = parseConfig(context.options)
  const client = context.client as unknown as {
    session?: { prompt?: (input: Record<string, unknown>) => Promise<unknown> }
  }
  const prompt = client?.session?.prompt
  if (typeof prompt !== "function") return
  const text = continuation(reason)
  const running = isRunning(context, sessionID)
  try {
    await prompt.call(client!.session, {
      sessionID,
      text,
      ...(running ? { delivery: "steer" } : { resume: true }),
    })
    writeResume(config.diagnosticsPath, sessionID, "resumed", running ? "steer" : "resume")
  } catch (error) {
    try {
      await prompt.call(client!.session, { sessionID, text, resume: true })
      writeResume(config.diagnosticsPath, sessionID, "resumed", "resume_fallback")
    } catch (fallbackError) {
      writeDiagnostic(config.diagnosticsPath, {
        timestamp: new Date().toISOString(),
        sessionID,
        event: "resume_failed",
        errorMessage: describeError(fallbackError).message,
      })
    }
  }
}

function writeResume(
  path: string | undefined,
  sessionID: string,
  event: "resumed",
  delivery: "steer" | "resume" | "resume_fallback",
): void {
  writeDiagnostic(path, { timestamp: new Date().toISOString(), sessionID, event, delivery })
}

function isRunning(context: Context, sessionID: string): boolean {
  const status = (context.data.session as { status?: (sessionID: string) => string }).status
  return typeof status === "function" ? status.call(context.data.session, sessionID) === "running" : false
}

function continuation(reason: string): string {
  return `${AUTO_PERMISSIONS_MESSAGE_PREFIX} ${reason} Do not retry the exact blocked action. Continue the task using a safer alternative when possible; ask the user only if no useful safe path remains.`
}

async function isStableRuntime(client: unknown): Promise<boolean> {
  const value = client as {
    health?: { get?: () => Promise<unknown> }
    global?: { health?: () => Promise<unknown> }
  }
  const health = typeof value?.health?.get === "function"
    ? value.health.get
    : typeof value?.global?.health === "function"
      ? value.global.health
      : undefined
  if (!health) return false
  try {
    const result = unwrap(await health.call(value.health ?? value.global))
    return protocolForVersion((result as { version?: string })?.version) === "stable"
  } catch {
    return false
  }
}

function unwrap(result: unknown): unknown {
  let value = result
  for (let depth = 0; depth < 3 && typeof value === "object" && value !== null && "data" in value; depth++) {
    value = (value as { data?: unknown }).data
  }
  return value
}

function fromLegacyApi(api: LegacyTuiApi, options: Readonly<Record<string, unknown>>): RuntimeContext {
  return {
    options,
    client: api.client,
    data: {
      on(type, handler) {
        return api.event.on(type as never, handler as never)
      },
      session: {
        root(sessionID) {
          const seen = new Set<string>()
          let current = sessionID
          while (!seen.has(current)) {
            seen.add(current)
            const parentID = api.state.session.get(current)?.parentID
            if (!parentID) return current
            current = parentID
          }
          return sessionID
        },
        get: (sessionID) => api.state.session.get(sessionID),
        message: {
          list: (sessionID) =>
            api.state.session.messages(sessionID).map((info) => ({ info, parts: api.state.part(info.id) })),
          get: (sessionID, messageID) => {
            const info = api.state.session.messages(sessionID).find((message) => message.id === messageID)
            return info ? { info, parts: api.state.part(info.id) } : undefined
          },
          sync: async () => {},
        },
        permission: {
          list: (sessionID) => api.state.session.permission(sessionID) as never,
          sync: async () => {},
        },
      },
      location: {
        default: () => ({ directory: api.state.path.directory }),
      },
    },
    location: { directory: api.state.path.directory },
    showToast: api.ui.toast,
    resumeAfterDenial(sessionID, reason) {
      void resumeLegacySession(api, sessionID, reason)
    },
  }
}

/**
 * Best-effort denial continuation for transitional V2 betas that call the
 * legacy TUI entrypoint. Their session prompt API takes `prompt: { text }`
 * instead of a flat `text` field; the stable client's `session.prompt` uses a
 * `{ path, query, body }` shape that must not be called accidentally.
 */
async function resumeLegacySession(api: LegacyTuiApi, sessionID: string, reason: string): Promise<void> {
  const client = api.client as {
    v2?: { session?: { prompt?: (input: Record<string, unknown>) => Promise<unknown> } }
    session?: { prompt?: (input: Record<string, unknown>) => Promise<unknown> }
    permission?: { request?: { list?: unknown } }
  }
  try {
    if (typeof client?.v2?.session?.prompt === "function") {
      await client.v2!.session!.prompt!({
        sessionID,
        prompt: { text: continuation(reason) },
        delivery: "queue",
        resume: true,
      })
      return
    }
    if (
      typeof client?.session?.prompt === "function" &&
      typeof client?.permission?.request?.list === "function"
    ) {
      await client.session!.prompt!({ sessionID, text: continuation(reason), resume: true })
    }
  } catch {
    // Resuming is best effort; the rejection itself already failed closed.
  }
}
