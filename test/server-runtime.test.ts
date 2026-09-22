import { describe, expect, test } from "bun:test"
import {
  canOwnServerReview,
  createServerRuntime,
  serverReviewCapabilities,
  type ServerPluginContext,
} from "../src/server-runtime.ts"

const DIRECTORY = "/repo"

function eventSource() {
  const queue: unknown[] = []
  let notify: (() => void) | undefined
  return {
    push(event: unknown) {
      queue.push(event)
      notify?.()
    },
    async *subscribe(options?: { signal?: AbortSignal }) {
      while (!options?.signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve
            options?.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          notify = undefined
          continue
        }
        yield queue.shift()
      }
    },
  }
}

function harness(overrides: Partial<ServerPluginContext["session"]> = {}) {
  const events = eventSource()
  const calls: Array<{ method: string; input: unknown }> = []
  const sessions: Record<string, { id: string; parentID?: string }> = {
    ses_root: { id: "ses_root" },
    ses_child: { id: "ses_child", parentID: "ses_root" },
  }
  const context: ServerPluginContext = {
    app: { version: "2.0.12" },
    options: {},
    location: { directory: DIRECTORY },
    event: { subscribe: (options) => events.subscribe(options) },
    permission: {
      list: async (input) => {
        calls.push({ method: "permission.list", input })
        return [{ id: "per_pending", sessionID: input.sessionID, action: "shell", resources: ["git status"], save: [] }]
      },
      reply: async (input) => calls.push({ method: "permission.reply", input }),
    },
    session: {
      create: async () => ({ id: "ses_review" }),
      get: async (input) => sessions[input.sessionID],
      context: async (input) => {
        calls.push({ method: "session.context", input })
        return [{ id: "msg_1", type: "user", text: "hello" }]
      },
      generate: async () => ({ text: "{}" }),
      interrupt: async () => {},
      prompt: async (input) => calls.push({ method: "session.prompt", input }),
      ...overrides,
    },
  }
  return { context, events, calls }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe("server runtime ownership predicate", () => {
  test("requires a released 2.x runtime and every reviewer surface", () => {
    const { context } = harness()
    const capabilities = serverReviewCapabilities(context)

    expect(capabilities).toContain("event.subscribe")
    expect(capabilities).toContain("permission.reply")
    expect(canOwnServerReview(capabilities, "2.0.12")).toBe(true)
    expect(canOwnServerReview(capabilities, "0.0.0-beta-202608110357")).toBe(false)
    expect(canOwnServerReview(capabilities, "1.18.32")).toBe(false)
    expect(canOwnServerReview(capabilities, undefined)).toBe(false)
    expect(canOwnServerReview(capabilities.filter((name) => name !== "session.generate"), "2.0.12")).toBe(false)
  })

  test("reports only the members that exist", () => {
    expect(serverReviewCapabilities({ event: {}, permission: { reply: () => {} } })).toEqual(["permission.reply"])
    expect(serverReviewCapabilities(undefined)).toEqual([])
  })
})

describe("server runtime event pump", () => {
  test("dispatches permission events for its own location only", async () => {
    const { context, events } = harness()
    const { runtime, dispose } = createServerRuntime(context)
    const asked: unknown[] = []
    const replied: unknown[] = []
    runtime.data.on("permission.asked", (event) => asked.push(event))
    runtime.data.on("permission.replied", (event) => replied.push(event))

    const request = { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["git status"], save: [] }
    events.push({ type: "permission.asked", location: { directory: "/elsewhere" }, data: { ...request, id: "per_other" } })
    events.push({ type: "permission.asked", location: { directory: DIRECTORY }, data: request })
    events.push({ type: "permission.asked", data: { ...request, id: "per_unlocated" } })
    events.push({ type: "permission.replied", location: { directory: DIRECTORY }, data: { sessionID: "ses_root", requestID: "per_1", reply: "once" } })
    await settle()

    expect(asked.map((event) => (event as { data: { id: string } }).data.id)).toEqual(["per_1", "per_unlocated"])
    expect(replied).toHaveLength(1)
    expect(runtime.data.session.permission.list("ses_root")?.map((item) => item.id)).toEqual(["per_unlocated"])
    dispose()
  })

  test("swallows the reviewer's own reply event but not a foreign one", async () => {
    const { context, events } = harness()
    const { runtime, expectOwnReply, dispose } = createServerRuntime(context)
    const replied: string[] = []
    runtime.data.on("permission.replied", (event) => replied.push((event as { data: { requestID: string } }).data.requestID))
    const release = expectOwnReply("per_mine")
    expectOwnReply("per_failed")()

    events.push({ type: "permission.replied", data: { sessionID: "ses_root", requestID: "per_mine", reply: "once" } })
    events.push({ type: "permission.replied", data: { sessionID: "ses_root", requestID: "per_failed", reply: "once" } })
    events.push({ type: "permission.replied", data: { sessionID: "ses_root", requestID: "per_human", reply: "reject" } })
    events.push({ type: "permission.replied", data: { sessionID: "ses_root", requestID: "per_mine", reply: "once" } })
    await settle()

    expect(replied).toEqual(["per_failed", "per_human", "per_mine"])
    release()
    dispose()
  })

  test("stops delivering after dispose", async () => {
    const { context, events } = harness()
    const { runtime, dispose } = createServerRuntime(context)
    const asked: unknown[] = []
    runtime.data.on("permission.asked", (event) => asked.push(event))
    dispose()

    events.push({ type: "permission.asked", data: { id: "per_late", sessionID: "ses_root", action: "shell", resources: ["ls"], save: [] } })
    await settle()

    expect(asked).toHaveLength(0)
  })
})

describe("server runtime session data", () => {
  test("resolves the root session through parent links", async () => {
    const { context } = harness()
    const { runtime, dispose } = createServerRuntime(context)

    await expect(runtime.data.session.root("ses_child")).resolves.toBe("ses_root")
    await expect(runtime.data.session.root("ses_root")).resolves.toBe("ses_root")
    await expect(runtime.data.session.root("ses_unknown")).resolves.toBe("ses_unknown")
    expect(runtime.data.session.get("ses_child")).toEqual({ id: "ses_child", parentID: "ses_root" })
    dispose()
  })

  test("syncs messages from session.context and permissions from permission.list", async () => {
    const { context, calls } = harness()
    const { runtime, dispose } = createServerRuntime(context)

    await runtime.data.session.message.sync("ses_root")
    await runtime.data.session.permission.sync("ses_root")

    expect(runtime.data.session.message.list("ses_root")).toEqual([{ id: "msg_1", type: "user", text: "hello" }])
    expect(runtime.data.session.message.get("ses_root", "msg_1")).toMatchObject({ id: "msg_1" })
    expect(runtime.data.session.permission.list("ses_root")?.map((item) => item.id)).toEqual(["per_pending"])
    expect(calls.map((call) => call.method)).toEqual(["session.context", "permission.list"])
    expect(runtime.location).toEqual({ directory: DIRECTORY })
    expect(runtime.data.location?.default()).toEqual({ directory: DIRECTORY })
    dispose()
  })
})

describe("server runtime denial continuation", () => {
  test("steers into a running session and queues into an idle one", async () => {
    const { context, events, calls } = harness()
    const { runtime, dispose } = createServerRuntime(context)

    runtime.resumeAfterDenial?.("ses_root", "Blocked.")
    await settle()
    events.push({ type: "session.execution.started", location: { directory: DIRECTORY }, data: { sessionID: "ses_root" } })
    await settle()
    runtime.resumeAfterDenial?.("ses_root", "Blocked again.")
    await settle()
    events.push({ type: "session.execution.succeeded", location: { directory: DIRECTORY }, data: { sessionID: "ses_root" } })
    await settle()
    runtime.resumeAfterDenial?.("ses_root", "Blocked once more.")
    await settle()

    const prompts = calls.filter((call) => call.method === "session.prompt").map((call) => call.input as Record<string, unknown>)
    expect(prompts.map((prompt) => prompt.delivery)).toEqual(["queue", "steer", "queue"])
    expect(prompts[0]?.text).toContain("[Auto Permissions] The requested action was blocked: Blocked.")
    expect(prompts.every((prompt) => prompt.sessionID === "ses_root")).toBe(true)
    dispose()
  })

  test("falls back to queue delivery when steering fails", async () => {
    const attempts: string[] = []
    const { context, events } = harness({
      prompt: async (input) => {
        attempts.push(String(input.delivery))
        if (input.delivery === "steer") throw new Error("steer unavailable")
      },
    })
    const { runtime, dispose } = createServerRuntime(context)
    events.push({ type: "session.execution.started", data: { sessionID: "ses_root" } })
    await settle()

    runtime.resumeAfterDenial?.("ses_root", "Blocked.")
    await settle()

    expect(attempts).toEqual(["steer", "queue"])
    dispose()
  })
})
