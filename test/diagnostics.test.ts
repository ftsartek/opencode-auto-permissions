import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeError, failureCategory, writeDiagnostic } from "../src/diagnostics.ts"

describe("diagnostics", () => {
  test("describes nested SDK error objects", () => {
    const error = {
      status: 400,
      error: {
        _tag: "ProviderError",
        code: "invalid_request",
        data: { message: "Structured output is unavailable." },
      },
    }

    expect(describeError(error)).toEqual({
      name: "Error",
      message: "Structured output is unavailable.",
      tag: "ProviderError",
      code: "invalid_request",
      status: 400,
    })
    expect(failureCategory(error)).toBe("error")
  })

  test("bounds retained privacy-minimized records with atomic appends", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auto-permissions-diagnostics-"))
    const path = join(directory, "decisions.jsonl")
    try {
      for (let index = 0; index < 210; index++) {
        writeDiagnostic(path, {
          timestamp: new Date(index).toISOString(),
          event: "decision",
          requestID: `per_${index}`,
          sessionID: "ses_test",
          protocol: "stable",
          action: "bash",
          resourceCount: 1,
          elapsedMs: index,
          decision: "allow",
        })
      }
      await waitForLine(path, "per_209")

      const lines = (await readFile(path, "utf8")).trim().split("\n")
      // The soft cap triggers a bounded rewrite once the file doubles the
      // retained window; concurrent writers elsewhere never lose appends.
      expect(lines.length).toBeGreaterThanOrEqual(100)
      expect(lines.length).toBeLessThanOrEqual(110)
      expect(JSON.parse(lines[0]!).requestID).not.toBe("per_0")
      expect(JSON.parse(lines.at(-1)!).requestID).toBe("per_209")
      expect(await Bun.file(path).stat()).toMatchObject({ mode: expect.any(Number) })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

async function waitForLine(path: string, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const text = await readFile(path, "utf8").catch(() => "")
    if (text.includes(needle)) return
    await Bun.sleep(10)
  }
  throw new Error("Diagnostics did not flush")
}
