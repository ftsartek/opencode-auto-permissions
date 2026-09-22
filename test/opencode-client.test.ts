import { describe, expect, test } from "bun:test"
import { OpenCodeClientAdapter, ServerContextClient } from "../src/opencode-client.ts"

describe("OpenCodeClientAdapter", () => {
  test("uses the current V2 session and permission APIs", async () => {
    const calls: Array<{ method: string; input: any }> = []
    const adapter = new OpenCodeClientAdapter({
      agent: { list: async () => [] },
      skill: { list: async () => [] },
      session: {
        create: async (input: any) => {
          calls.push({ method: "create", input })
          return { id: "ses_review" }
        },
        generate: async (input: any) => {
          calls.push({ method: "generate", input })
          return { text: '{"decision":"allow","reasonCode":"safe","reason":"Safe operation."}' }
        },
        remove: async (input: any) => calls.push({ method: "remove", input }),
        interrupt: async () => {},
      },
      permission: {
        request: { list: async () => ({ data: [] }) },
        reply: async (input: any) => calls.push({ method: "reply", input }),
      },
    })

    await adapter.prewarm()
    await expect(adapter.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })).resolves.toEqual({ decision: "allow", reasonCode: "safe", reason: "Safe operation." })
    await expect(adapter.reply({
      sessionID: "ses_parent",
      requestID: "per_1",
      reply: "once",
      protocol: "v2",
    })).resolves.toBe("replied")

    expect(calls.map((call) => call.method)).toEqual(["create", "generate", "remove", "reply"])
    expect(calls[0]?.input).toMatchObject({
      agent: "auto-permissions-reviewer",
      model: { providerID: "example", id: "luna-5.6" },
    })
    expect(calls[3]?.input).toEqual({ sessionID: "ses_parent", requestID: "per_1", decision: "once" })
  })

  test("prewarms the reviewer location without invoking a model", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      app: {
        agents: async () => calls.push("agents"),
        skills: async () => calls.push("skills"),
      },
    })

    await client.prewarm()

    expect(calls).toEqual(["agents", "skills"])
  })

  test("does not delete reviewer sessions owned by another OpenCode process", async () => {
    const deleted: unknown[] = []
    const client = new OpenCodeClientAdapter({
      app: {
        agents: async () => undefined,
        skills: async () => undefined,
      },
      v2: {
        session: {
          list: async () => ({
            data: {
              data: [
                { id: "ses_review", title: "Auto Permissions review" },
                { id: "ses_user", title: "User session" },
              ],
            },
          }),
          delete: async (input: unknown) => deleted.push(input),
        },
      },
    })

    await client.prewarm()

    expect(deleted).toEqual([])
  })

  test("uses an isolated deny-all reviewer session and deletes it", async () => {
    const calls: Array<{ method: string; input: any }> = []
    const client = new OpenCodeClientAdapter({
      session: {
        async create(input: unknown) {
          calls.push({ method: "create", input })
          return { data: { id: "ses_review" } }
        },
        async prompt(input: unknown) {
          calls.push({ method: "prompt", input })
          return {
            data: {
              info: {
                role: "assistant",
                structured: { decision: "deny", reasonCode: "x", reason: "Review." },
              },
              parts: [],
            },
          }
        },
        async delete(input: unknown) {
          calls.push({ method: "delete", input })
          return { data: true }
        },
      },
    })

    const text = await client.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })

    expect(text).toEqual({ decision: "deny", reasonCode: "x", reason: "Review." })
    expect(calls.map((call) => call.method)).toEqual(["create", "prompt", "delete"])
    expect(calls[0]?.input).toMatchObject({
      agent: "auto-permissions-reviewer",
      model: { providerID: "example", id: "luna-5.6" },
      permission: [
        { permission: "*", pattern: "*", action: "deny" },
        { permission: "StructuredOutput", pattern: "*", action: "allow" },
      ],
      directory: expect.stringContaining("opencode-auto-permissions"),
    })
    expect(calls[0]?.input).not.toHaveProperty("parentID")
    expect(calls[1]?.input).toMatchObject({
      agent: "auto-permissions-reviewer",
      format: {
        type: "json_schema",
        retryCount: 1,
      },
    })
  })

  test("prefers the V2 subclient for structured reviewer sessions when available", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      session: {
        create: async () => {
          calls.push("legacy")
          return { data: { id: "ses_legacy" } }
        },
        prompt: async () => ({ data: {} }),
      },
      v2: {
        session: {
          create: async () => {
            calls.push("v2-create")
            return { data: { id: "ses_review" } }
          },
          prompt: async () => {
            calls.push("v2-prompt")
            return { data: { info: { structured: { decision: "deny", reasonCode: "x", reason: "Review." } } } }
          },
          delete: async () => calls.push("v2-delete"),
        },
      },
    })

    await client.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })

    expect(calls).toEqual(["v2-create", "v2-prompt", "v2-delete"])
  })

  test("deletes the reviewer session when generation fails", async () => {
    let deleted = false
    const client = new OpenCodeClientAdapter({
      session: {
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async () => {
          throw new Error("provider failed")
        },
        delete: async () => {
          deleted = true
        },
      },
    })

    await expect(
      client.generate({
        prompt: "review",
        model: { providerID: "example", id: "luna-5.6" },
        parentSessionID: "ses_parent",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("provider failed")
    expect(deleted).toBeTrue()
  })

  test("falls back to strict JSON text when structured output is unavailable", async () => {
    const prompts: any[] = []
    const client = new OpenCodeClientAdapter({
      session: {
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async (input: any) => {
          prompts.push(input)
          if (prompts.length === 1) {
            return {
              data: {
                info: {
                  error: { name: "StructuredOutputError", data: { message: "No structured output", retries: 1 } },
                },
                parts: [],
              },
            }
          }
          return {
            data: {
              info: { role: "assistant" },
              parts: [{
                type: "text",
                text: '{"decision":"allow","reasonCode":"authorized","reason":"Requested by the user."}',
              }],
            },
          }
        },
        delete: async () => ({ data: true }),
      },
    })

    await expect(client.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      decision: "allow",
      reasonCode: "authorized",
      reason: "Requested by the user.",
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({ format: { type: "text" } })
    expect(prompts[1].parts[0].text).toContain('exactly these three keys')
    expect(prompts[1].parts[0].text).toContain('"decision": one of "allow", "allow_session", or "deny"')
  })

  test("creates the stable reviewer session with a permission ruleset that allows structured output", async () => {
    const creates: any[] = []
    const client = new OpenCodeClientAdapter({
      postSessionIdPermissionsPermissionId: async () => {},
      session: {
        create: async (input: unknown) => {
          creates.push(input)
          return { data: { id: "ses_review" } }
        },
        prompt: async () => ({
          data: {
            info: { structured: { decision: "deny", reasonCode: "x", reason: "Review." } },
            parts: [],
          },
        }),
        delete: async () => ({ data: true }),
      },
    })

    await client.generate({
      prompt: "review",
      model: { providerID: "example", id: "luna-5.6" },
      parentSessionID: "ses_parent",
      signal: new AbortController().signal,
    })

    expect(creates[0]).toMatchObject({
      query: { directory: expect.stringContaining("opencode-auto-permissions") },
      body: {
        title: "Auto Permissions review",
        permission: [
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "StructuredOutput", pattern: "*", action: "allow" },
        ],
      },
    })
  })

  test("uses the generated stable abort envelope when review is cancelled", async () => {
    const calls: unknown[] = []
    const controller = new AbortController()
    const client = new OpenCodeClientAdapter({
      postSessionIdPermissionsPermissionId: async () => {},
      session: {
        create: async () => ({ data: { id: "ses_review" } }),
        prompt: async () => {
          controller.abort("permission resolved")
          throw new DOMException("permission resolved", "AbortError")
        },
        abort: async (input: unknown) => calls.push(input),
        delete: async () => ({ data: true }),
      },
    })

    await expect(
      client.generate({
        prompt: "review",
        model: { providerID: "cloudflare-workers-ai", id: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
        parentSessionID: "ses_parent",
        signal: controller.signal,
      }),
    ).rejects.toThrow("permission resolved")
    await Promise.resolve()

    expect(calls).toEqual([
      {
        path: { id: "ses_review" },
        query: { directory: expect.stringContaining("opencode-auto-permissions") },
      },
    ])
  })

  test("treats a permission 404 as a lost race", async () => {
    const permission = {
      marker: "bound",
      async reply(this: { marker: string }) {
        expect(this.marker).toBe("bound")
        throw { status: 404 }
      },
    }
    const client = new OpenCodeClientAdapter({
      v2: {
        session: {
          permission,
        },
      },
    })

    await expect(
      client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" }),
    ).resolves.toBe("not_found")
  })

  test("prefers the V2 session-scoped permission endpoint", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      permission: {
        reply: async () => calls.push("legacy"),
      },
      v2: {
        session: {
          permission: {
            reply: async () => calls.push("v2"),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" })

    expect(calls).toEqual(["v2"])
  })

  test("sends session approval through the V2 endpoint", async () => {
    const replies: unknown[] = []
    const client = new OpenCodeClientAdapter({
      v2: {
        session: {
          permission: {
            reply: async (input: unknown) => replies.push(input),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "always", protocol: "v2" })

    expect(replies).toEqual([{ sessionID: "ses_1", requestID: "per_1", reply: "always", protocol: "v2" }])
  })

  test("uses the direct V2 TUI session permission endpoint", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      session: {
        permission: {
          reply: async () => calls.push("v2-tui"),
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" })

    expect(calls).toEqual(["v2-tui"])
  })

  test("falls back for transitional V2 requests in the legacy permission queue", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      permission: {
        reply: async () => calls.push("legacy"),
      },
      v2: {
        session: {
          permission: {
            reply: async () => ({ error: { _tag: "PermissionNotFoundError" } }),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "v2" })

    expect(calls).toEqual(["legacy"])
  })

  test("uses the stable permission endpoint for stable events", async () => {
    const calls: string[] = []
    const client = new OpenCodeClientAdapter({
      permission: {
        reply: async () => calls.push("stable"),
      },
      v2: {
        session: {
          permission: {
            reply: async () => calls.push("v2"),
          },
        },
      },
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "stable" })

    expect(calls).toEqual(["stable"])
  })

  test("sends session approval through the generated stable endpoint", async () => {
    const replies: unknown[] = []
    const client = new OpenCodeClientAdapter({
      postSessionIdPermissionsPermissionId: async (input: unknown) => replies.push(input),
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "always", protocol: "stable" })

    expect(replies).toEqual([{ path: { id: "ses_1", permissionID: "per_1" }, body: { response: "always" } }])
  })

  test("uses the generated stable permission endpoint", async () => {
    const calls: unknown[] = []
    const client = new OpenCodeClientAdapter({
      postSessionIdPermissionsPermissionId: async (input: unknown) => calls.push(input),
    })

    await client.reply({ sessionID: "ses_1", requestID: "per_1", reply: "once", protocol: "stable" })

    expect(calls).toEqual([{ path: { id: "ses_1", permissionID: "per_1" }, body: { response: "once" } }])
  })
})

describe("ServerContextClient", () => {
  function serverContext() {
    const calls: Array<{ method: string; input: any }> = []
    let created = 0
    const deleted = new Set<string>()
    const context = {
      location: { directory: "/repo" },
      permission: {
        list: async () => [],
        reply: async (input: any) => {
          calls.push({ method: "reply", input })
          if (input.requestID === "per_gone") throw new Error("Permission request not found: per_gone")
        },
      },
      session: {
        create: async (input: any) => {
          calls.push({ method: "create", input })
          created++
          return { id: `ses_review_${created}` }
        },
        generate: async (input: any) => {
          calls.push({ method: "generate", input })
          if (deleted.has(input.sessionID)) throw Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" })
          return { text: '{"decision":"allow","reasonCode":"safe","reason":"Safe operation."}' }
        },
        interrupt: async (input: any) => calls.push({ method: "interrupt", input }),
        get: async () => undefined,
        context: async () => [],
        prompt: async () => {},
      },
    }
    return { context, calls, deleted }
  }
  const model = { providerID: "example", id: "luna-5.6" }
  const signal = () => new AbortController().signal

  test("reuses one reviewer session per model in the plugin's own location", async () => {
    const { context, calls } = serverContext()
    const client = new ServerContextClient(context)

    await client.generate({ prompt: "first", model, parentSessionID: "ses_parent", signal: signal() })
    await client.generate({ prompt: "second", model, parentSessionID: "ses_parent", signal: signal() })
    await client.generate({ prompt: "third", model: { ...model, variant: "low" }, parentSessionID: "ses_parent", signal: signal() })

    expect(calls.map((call) => call.method)).toEqual(["create", "generate", "generate", "create", "generate"])
    expect(calls[0]?.input).toMatchObject({
      agent: "auto-permissions-reviewer",
      model: { providerID: "example", id: "luna-5.6" },
      location: { directory: "/repo" },
    })
    expect(calls[3]?.input.model).toEqual({ providerID: "example", id: "luna-5.6", variant: "low" })
    expect(calls[1]?.input.prompt).toContain("Return only one JSON object")
  })

  test("recreates the reviewer session once when it has disappeared", async () => {
    const { context, calls, deleted } = serverContext()
    const client = new ServerContextClient(context)
    await client.generate({ prompt: "first", model, parentSessionID: "ses_parent", signal: signal() })
    deleted.add("ses_review_1")

    await expect(client.generate({ prompt: "second", model, parentSessionID: "ses_parent", signal: signal() }))
      .resolves.toEqual({ decision: "allow", reasonCode: "safe", reason: "Safe operation." })

    expect(calls.map((call) => call.method)).toEqual(["create", "generate", "generate", "create", "generate"])
    expect(calls[4]?.input.sessionID).toBe("ses_review_2")
  })

  test("replies with the decision field and maps a lost race to not_found", async () => {
    const { context, calls } = serverContext()
    const client = new ServerContextClient(context)

    await expect(client.reply({ sessionID: "ses_root", requestID: "per_1", reply: "reject", message: "No.", protocol: "v2" }))
      .resolves.toBe("replied")
    await expect(client.reply({ sessionID: "ses_root", requestID: "per_gone", reply: "once", protocol: "v2" }))
      .resolves.toBe("not_found")

    expect(calls[0]?.input).toEqual({ sessionID: "ses_root", requestID: "per_1", decision: "reject", message: "No." })
  })

  test("announces each reply through the hook and releases it on failure", async () => {
    const { context } = serverContext()
    const announced: string[] = []
    const released: string[] = []
    const client = new ServerContextClient(context, {
      onReply: (requestID) => {
        announced.push(requestID)
        return () => released.push(requestID)
      },
    })

    await client.reply({ sessionID: "ses_root", requestID: "per_1", reply: "once", protocol: "v2" })
    await client.reply({ sessionID: "ses_root", requestID: "per_gone", reply: "once", protocol: "v2" })

    expect(announced).toEqual(["per_1", "per_gone"])
    expect(released).toEqual(["per_gone"])
  })

  test("interrupts the reviewer session when a review is aborted", async () => {
    const { context, calls } = serverContext()
    context.session.generate = async (input: any) => {
      calls.push({ method: "generate", input })
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { text: '{"decision":"allow","reasonCode":"safe","reason":"Safe."}' }
    }
    const client = new ServerContextClient(context)
    const controller = new AbortController()
    const pending = client.generate({ prompt: "slow", model, parentSessionID: "ses_parent", signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort("timed out")
    await pending.catch(() => undefined)

    expect(calls.some((call) => call.method === "interrupt" && call.input.sessionID === "ses_review_1")).toBe(true)
  })
})
