import type { Decision } from "./types.ts"

const DECISIONS = new Set(["allow", "allow_session", "deny"])
const KEYS = ["decision", "reason", "reasonCode"]
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/
const MAX_REASON_LENGTH = 240

export function parseDecision(value: unknown): Decision | null {
  if (!isRecord(value)) return null
  if (Object.keys(value).sort().join(",") !== KEYS.join(",")) return null

  const decision = value.decision
  const reasonCode = value.reasonCode
  const reason = value.reason
  if (typeof decision !== "string" || !DECISIONS.has(decision)) return null
  if (typeof reasonCode !== "string" || !REASON_CODE.test(reasonCode)) return null
  if (typeof reason !== "string" || !reason.trim()) return null
  // Verbose but otherwise valid decisions are usable: trimming keeps the
  // structured result inside the reason contract instead of failing the review
  // and blocking the action the reviewer intended to approve or deny.
  return { kind: decision as Decision["kind"], reasonCode, reason: reason.slice(0, MAX_REASON_LENGTH) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
