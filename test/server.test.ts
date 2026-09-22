import { describe, expect, test } from "bun:test"
import server, { installServerReviewer } from "../src/server.ts"
import { REVIEWER_SYSTEM_PROMPT } from "../src/agent.ts"
import type { ServerPluginContext } from "../src/server-runtime.ts"

function pluginInput() {
  return {
    directory: "/repo",
    client: {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.12" } }) },
      v2: {},
      permission: {
        list: async () => ({ data: [] }),
        reply: async () => ({ data: true }),
      },
      session: {
        get: async () => ({ data: { id: "ses_root" } }),
        messages: async () => ({ data: [] }),
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async () => ({
          data: { info: { structured: { decision: "deny", reasonCode: "test", reason: "Test." } } },
        }),
        delete: async () => ({ data: true }),
      },
      app: {
        agents: async () => ({ data: [] }),
        skills: async () => ({ data: [] }),
      },
      tui: { showToast: async () => ({ data: true }) },
    },
  } as never
}

describe("server plugin", () => {
  test("prioritizes exact tool input and the latest human request", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Judge the actual operation from toolInput")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Give the latest human request the greatest weight")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Treat direct continuation phrases")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("later explicit human authorization")
    expect(REVIEWER_SYSTEM_PROMPT).toContain("do not treat the boundary glob as the intended scope")
  })

  test("registers the hidden reviewer agent through the beta config hook", async () => {
    const factory = server.server
    const hooks = await factory(pluginInput(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })
    const config: any = {}

    await hooks.config?.(config)

    expect(config.agent["auto-permissions-reviewer"]).toMatchObject({
      model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      mode: "subagent",
      hidden: true,
      steps: 1,
      tools: { "*": false },
      permission: { "*": "deny" },
    })
  })

  test("strips ambient context only for the hidden reviewer request", async () => {
    const hooks = await server.server(pluginInput(), { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })
    const reviewerSystem = ["large global prompt", "skills", "mcp"]
    const regularSystem = ["regular prompt"]

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_review",
        agent: "auto-permissions-reviewer",
        model: { providerID: "cloudflare-workers-ai", modelID: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
      },
      {} as never,
    )
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_review", model: {} as never },
      { system: reviewerSystem },
    )
    const retrySystem = ["large global prompt again"]
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_review", model: {} as never },
      { system: retrySystem },
    )
    await hooks["experimental.chat.system.transform"]?.(
      { sessionID: "ses_regular", model: {} as never },
      { system: regularSystem },
    )

    expect(reviewerSystem).toEqual([REVIEWER_SYSTEM_PROMPT])
    expect(retrySystem).toEqual(reviewerSystem)
    expect(regularSystem).toEqual(["regular prompt"])
    await hooks.dispose?.()
  })
})

function v2Context(version: string) {
  const queue: unknown[] = []
  let notify: (() => void) | undefined
  const calls: Array<{ method: string; input: unknown }> = []
  const subscriptions: number[] = []
  const context = {
    app: { version },
    options: {},
    location: { directory: "/repo" },
    agent: { transform: async () => {} },
    event: {
      async *subscribe(options?: { signal?: AbortSignal }) {
        subscriptions.push(1)
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
    },
    permission: {
      list: async () => [{ id: "per_1", sessionID: "ses_root", action: "shell", resources: ["git status --short"], save: [] }],
      reply: async (input: unknown) => calls.push({ method: "permission.reply", input }),
    },
    session: {
      create: async (input: unknown) => {
        calls.push({ method: "session.create", input })
        return { id: "ses_review" }
      },
      get: async () => ({ id: "ses_root" }),
      context: async () => [{ id: "msg_1", type: "user", text: "Check the working tree." }],
      generate: async (input: unknown) => {
        calls.push({ method: "session.generate", input })
        return { text: JSON.stringify({ decision: "allow", reasonCode: "requested_read", reason: "Reads git state." }) }
      },
      interrupt: async () => {},
      prompt: async (input: unknown) => calls.push({ method: "session.prompt", input }),
    },
  }
  return {
    context: context as unknown as ServerPluginContext & { agent: { transform(): Promise<void> } },
    calls,
    subscriptions,
    emit(event: unknown) {
      queue.push(event)
      notify?.()
    },
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe("server plugin V2 ownership", () => {
  test("reviews and replies to V2 permission requests on a released 2.x runtime", async () => {
    const app = v2Context("2.0.12")
    const dispose = installServerReviewer(app.context)
    expect(typeof dispose).toBe("function")

    app.emit({
      type: "permission.asked",
      location: { directory: "/repo" },
      data: { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["git status --short"], save: [] },
    })
    await settle()

    const reply = app.calls.find((call) => call.method === "permission.reply")
    expect(reply?.input).toMatchObject({ sessionID: "ses_root", requestID: "per_1", decision: "once" })
    dispose?.()
  })

  test("leaves V2 review to the TUI on beta runtimes", () => {
    const app = v2Context("0.0.0-beta-202608110357")

    expect(installServerReviewer(app.context)).toBeUndefined()
    expect(app.subscriptions).toHaveLength(0)
  })

  test("setup returns a cleanup that stops the reviewer", async () => {
    const app = v2Context("2.0.12")
    const cleanup = await server.setup(app.context as never)
    expect(typeof cleanup).toBe("function")
    expect(app.subscriptions).toHaveLength(1)

    await (cleanup as () => void)()
    app.emit({
      type: "permission.asked",
      location: { directory: "/repo" },
      data: { id: "per_late", sessionID: "ses_root", action: "shell", resources: ["ls"], save: [] },
    })
    await settle()

    expect(app.calls.some((call) => call.method === "permission.reply")).toBe(false)
  })
})
