import { describe, expect, test } from "bun:test"
import { parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("parses an arbitrary provider/model reference", () => {
    expect(parseConfig({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731" })).toEqual({
      model: { providerID: "cloudflare-workers-ai", id: "@cf/deepseek-ai/deepseek-v4-flash-0731" },
      modelLabel: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      variant: undefined,
      timeoutMs: 30_000,
      userMessageCount: 8,
      readOnlyAgents: ["plan"],
      enableAutoReadOnly: true,
      shadow: false,
      sessionApprovals: true,
      runtime: "auto",
      diagnosticsPath: undefined,
    })
  })

  test("allows slashes inside the model id", () => {
    expect(parseConfig({ model: "provider/org/model" }).model).toEqual({
      providerID: "provider",
      id: "org/model",
    })
  })

  test("applies an optional reviewer variant", () => {
    expect(parseConfig({ model: "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731", variant: "high" }).model).toEqual({
      providerID: "cloudflare-workers-ai",
      id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
      variant: "high",
    })
    expect(() => parseConfig({ model: "a/b", variant: "" })).toThrow(/variant/)
  })

  test("inherits the requesting session model by default", () => {
    expect(parseConfig({})).toMatchObject({ model: undefined, modelLabel: undefined, variant: undefined })
  })

  test.each([{ model: "" }, { model: "deepseek-v4-flash-0731" }, { model: "/deepseek-v4-flash-0731" }, { model: "provider/" }])(
    "rejects invalid model option %#",
    (options) => expect(() => parseConfig(options)).toThrow(),
  )

  test("rejects out-of-range runtime options", () => {
    expect(() => parseConfig({ model: "a/b", timeoutMs: 99 })).toThrow(/timeoutMs/)
    expect(() => parseConfig({ model: "a/b", userMessageCount: 21 })).toThrow(/userMessageCount/)
  })

  test("supports a diagnostics-only runtime override", () => {
    expect(parseConfig({ model: "a/b", runtime: "stable" }).runtime).toBe("stable")
    expect(parseConfig({ model: "a/b", runtime: "v2" }).runtime).toBe("v2")
    expect(() => parseConfig({ model: "a/b", runtime: "other" })).toThrow(/runtime/)
  })

  test("allows session approvals to be disabled", () => {
    expect(parseConfig({ model: "a/b" }).sessionApprovals).toBeTrue()
    expect(parseConfig({ model: "a/b", sessionApprovals: false }).sessionApprovals).toBeFalse()
  })

  test("allows automatic read-only review to be disabled", () => {
    expect(parseConfig({ model: "a/b" }).enableAutoReadOnly).toBeTrue()
    expect(parseConfig({ model: "a/b", enableAutoReadOnly: false }).enableAutoReadOnly).toBeFalse()
  })

  test("adds configured read-only agents to the built-in plan agent", () => {
    expect(parseConfig({ readOnlyAgents: ["review-only", "plan", " review-only "] }).readOnlyAgents).toEqual([
      "plan",
      "review-only",
    ])
    expect(() => parseConfig({ readOnlyAgents: "review-only" })).toThrow(/readOnlyAgents/)
    expect(() => parseConfig({ readOnlyAgents: [""] })).toThrow(/readOnlyAgents/)
  })

  test("enables bounded diagnostics with a default or explicit path", () => {
    expect(parseConfig({ model: "a/b", debug: true }).diagnosticsPath).toEndWith("opencode/auto-permissions/decisions.jsonl")
    expect(parseConfig({ model: "a/b", debug: "/tmp/decisions.jsonl" }).diagnosticsPath).toBe("/tmp/decisions.jsonl")
    expect(() => parseConfig({ model: "a/b", debug: 1 })).toThrow(/debug/)
  })
})
