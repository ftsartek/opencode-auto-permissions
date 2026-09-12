import { describe, expect, test } from "bun:test"
import plugin from "../src/tui.ts"
import type { Context } from "@opencode-ai/plugin/tui/plugin"

function context(version: string): { context: Context; subscriptions: string[] } {
  const subscriptions: string[] = []
  return {
    context: {
      options: { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      client: {
        global: { health: async () => ({ data: { healthy: true, version } }) },
      },
      data: {
        on(type: string) {
          subscriptions.push(type)
          return () => {}
        },
        session: {
          root: (id: string) => id,
          get: (id: string) => ({ id }),
          message: { list: () => [], get: () => undefined, sync: async () => {} },
          permission: { list: () => [], sync: async () => {} },
        },
      },
      ui: { toast: { show() {} } },
    } as unknown as Context,
    subscriptions,
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

describe("TUI plugin runtime ownership", () => {
  test("owns V2 permission events", async () => {
    const app = context("0.0.0-beta-202608040144")

    const dispose = await plugin.setup(app.context)

    expect(app.subscriptions).toEqual([
      "permission.v2.replied",
      "permission.replied",
      "permission.v2.asked",
      "permission.asked",
    ])
    expect(typeof dispose).toBe("function")
    dispose?.()
  })
})

describe("TUI plugin denial continuation", () => {
  test("writes the denial reason into the main session after a rejection", async () => {
    const handlers = new Map<string, Set<(event: unknown) => void>>()
    const replies: Array<Record<string, unknown>> = []
    const prompts: Array<Record<string, unknown>> = []
    const statuses: string[] = ["running", "running", "idle"]
    const pending = [
      { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["sudo rm -rf /"], save: [] },
    ]

    const app: Context = {
      options: { model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" },
      client: {
        permission: {
          reply: async (input: Record<string, unknown>) => {
            replies.push(input)
            pending.length = 0
          },
        },
        session: {
          prompt: async (input: Record<string, unknown>) => {
            prompts.push(input)
          },
        },
      },
      data: {
        on(type: string, handler: (event: unknown) => void) {
          const set = handlers.get(type) ?? new Set()
          set.add(handler)
          handlers.set(type, set)
          return () => set.delete(handler)
        },
        session: {
          root: (id: string) => id,
          get: (id: string) => ({ id }),
          status: () => statuses.shift() ?? "idle",
          message: { list: () => [], get: () => undefined, sync: async () => {} },
          permission: { list: () => pending, sync: async () => {} },
        },
      },
      ui: { toast: { show() {} } },
    } as unknown as Context

    const dispose = await plugin.setup(app)
    try {
      const emit = (type: string, data: unknown) => {
        for (const handler of handlers.get(type) ?? []) handler({ type, data })
      }
      emit("permission.asked", pending[0])
      await settle()

      expect(replies).toHaveLength(1)
      expect(replies[0]).toMatchObject({
        sessionID: "ses_root",
        requestID: "per_1",
        reply: "reject",
        message: expect.stringContaining("blocked"),
      })
      expect(prompts).toHaveLength(1)
      const continuation = String(prompts[0]?.text)
      expect(prompts[0]).toMatchObject({ sessionID: "ses_root", resume: true })
      expect(continuation).toContain("[Auto Permissions] The requested action was blocked:")
      expect(continuation).toContain("Do not retry the exact blocked action")
      expect(statuses).toEqual([])
    } finally {
      dispose?.()
    }
  })

  test("resumes through the legacy V2 client after a rejection", async () => {
    const handlers = new Map<string, Set<(event: unknown) => void>>()
    const replies: Array<Record<string, unknown>> = []
    const prompts: Array<Record<string, unknown>> = []
    const pending = [
      { id: "per_1", sessionID: "ses_root", action: "shell", resources: ["sudo rm -rf /"], always: [] },
    ]

    const api = {
      client: {
        permission: {
          reply: async (input: Record<string, unknown>) => {
            replies.push(input)
            pending.length = 0
          },
        },
        v2: {
          session: {
            prompt: async (input: Record<string, unknown>) => {
              prompts.push(input)
            },
          },
        },
      },
      state: {
        session: {
          get: (id: string) => ({ id }),
          messages: () => [],
          permission: () => pending,
        },
        part: () => [],
        path: { directory: "/repo" },
      },
      event: {
        on(type: string, handler: (event: unknown) => void) {
          const set = handlers.get(type) ?? new Set()
          set.add(handler)
          handlers.set(type, set)
          return () => set.delete(handler)
        },
      },
      ui: { toast() {} },
      lifecycle: { onDispose() {} },
    }

    await plugin.tui(api as never, {})
    const emit = (type: string, data: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler({ type, data })
    }
    emit("permission.v2.asked", pending[0])
    await settle()

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ reply: "reject", requestID: "per_1" })
    expect(prompts).toHaveLength(1)
    const continuation = String((prompts[0]?.prompt as { text?: string } | undefined)?.text)
    expect(prompts[0]).toMatchObject({ sessionID: "ses_root", delivery: "queue", resume: true })
    expect(continuation).toContain("[Auto Permissions] The requested action was blocked:")
  })
})
