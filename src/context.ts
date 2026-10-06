import type { ConversationEntry, PermissionRequest, ReviewInput, ReviewModel, RuntimeContext } from "./types.ts"

const MAX_MESSAGE_CHARS = 4_000
export const AUTO_PERMISSIONS_MESSAGE_PREFIX = "[Auto Permissions] The requested action was blocked:"

export function normalizeAskedEvent(event: unknown): PermissionRequest | null {
  if (!isRecord(event)) return null
  const data = payload(event)
  if (
    event.type === "permission.v2.asked" ||
    (event.type === "permission.asked" && validRequest(data, "action", "resources"))
  ) {
    if (!validRequest(data, "action", "resources")) return null
    return {
      id: data.id,
      sessionID: data.sessionID,
      action: data.action,
      resources: [...data.resources],
      // Newer V2 runtimes renamed the reusable-pattern field to "save";
      // older betas and stable events still use "always".
      always: stringArray(data.always ?? data.save),
      ...(normalizeTool(data.source) ? { source: normalizeTool(data.source)! } : {}),
      protocol: "v2",
    }
  }

  if (event.type !== "permission.asked" && event.type !== "permission.updated") return null
  if (!data || typeof data.id !== "string" || typeof data.sessionID !== "string") return null
  const action = typeof data.permission === "string" ? data.permission : data.type
  const rawResources = data.patterns ?? data.pattern
  const resources = Array.isArray(rawResources) ? rawResources : typeof rawResources === "string" ? [rawResources] : []
  if (typeof action !== "string" || resources.length === 0 || !resources.every((item) => typeof item === "string"))
    return null
  const tool = normalizeTool(data.tool)
    ? normalizeTool(data.tool)!
    : typeof data.messageID === "string" && typeof data.callID === "string"
      ? { type: "tool" as const, messageID: data.messageID, callID: data.callID }
      : undefined
  return {
    id: data.id,
    sessionID: data.sessionID,
    action,
    resources,
    always: stringArray(data.always),
    ...(tool ? { source: tool } : {}),
    protocol: "stable",
  }
}

export function normalizeRepliedEvent(event: unknown): { sessionID: string; requestID: string } | null {
  if (!isRecord(event) || !["permission.v2.replied", "permission.replied"].includes(String(event.type))) return null
  const data = payload(event)
  const requestID = data?.requestID ?? data?.permissionID
  if (!isRecord(data) || typeof data.sessionID !== "string" || typeof requestID !== "string") return null
  return { sessionID: data.sessionID, requestID }
}

export async function collectReviewInput(
  context: RuntimeContext,
  request: PermissionRequest,
  userMessageCount: number,
): Promise<ReviewInput> {
  const rootSessionID = await context.data.session.root(request.sessionID)
  await Promise.all([
    context.data.session.message.sync(rootSessionID),
    request.sessionID === rootSessionID ? Promise.resolve() : context.data.session.message.sync(request.sessionID),
  ])

  const rootMessages = context.data.session.message.list(rootSessionID)
  const sessionMessages = request.sessionID === rootSessionID
    ? []
    : context.data.session.message.list(request.sessionID)
  const conversation = [...rootMessages, ...sessionMessages]
    .flatMap((message): ConversationEntry[] => {
      const text = userText(message)
      if (text !== undefined) return [{ kind: "user_message", text: text.slice(0, MAX_MESSAGE_CHARS) }]
      return questionEntries(message)
    })
    .slice(-userMessageCount)
  const currentDirectory = directory(context)
  const model = latestUserModel(sessionMessages) ?? latestUserModel(rootMessages)

  return {
    request: {
      action: request.action,
      resources: [...request.resources],
      sessionPatterns: [...request.always],
      ...(request.source?.type === "tool"
        ? { toolInput: findToolInput(context, request.sessionID, request.source.messageID, request.source.callID) }
        : {}),
    },
    context: {
      rootSessionID,
      ...(currentDirectory ? { directory: currentDirectory } : {}),
      conversation,
      ...(model ? { model } : {}),
    },
  }
}

function latestUserModel(messages: unknown[]): ReviewModel | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const model = messageModel(message)
    if (model) return model
  }
  return undefined
}

function messageModel(message: Record<string, any>): ReviewModel | undefined {
  // Newer V2 runtimes expose messages as flat records and user prompts carry no
  // model there, so the most recent assistant turn is the closest routing
  // signal for the reviewer.
  const info = isRecord(message.info) ? message.info : message
  const role = info.role ?? message.type
  if (role !== "user" && role !== "assistant") return undefined
  const raw = isRecord(info.model) ? info.model : undefined
  if (!raw) return undefined
  const providerID = raw.providerID
  const id = raw.modelID ?? raw.id
  if (typeof providerID !== "string" || typeof id !== "string") return undefined
  const variant = typeof raw.variant === "string" ? raw.variant : undefined
  return { providerID, id, ...(variant ? { variant } : {}) }
}

export async function isRequestPending(context: RuntimeContext, request: PermissionRequest): Promise<boolean> {
  await context.data.session.permission.sync(request.sessionID)
  return context.data.session.permission.list(request.sessionID)?.some((item) => item.id === request.id) ?? false
}

function findToolInput(
  context: RuntimeContext,
  sessionID: string,
  messageID: string,
  callID: string,
): unknown {
  const message = context.data.session.message.get(sessionID, messageID)
  const tool = toolParts(message).find((part) => part.id === callID || part.callID === callID)
  return isRecord(tool?.state) ? tool.state.input : undefined
}

function toolParts(message: unknown): Record<string, any>[] {
  if (!isRecord(message)) return []
  const parts =
    message.type === "assistant" && Array.isArray(message.content)
      ? message.content
      : isRecord(message.info) && message.info.role === "assistant" && Array.isArray(message.parts)
        ? message.parts
        : []
  return parts.filter((part): part is Record<string, any> => isRecord(part) && part.type === "tool")
}

function questionEntries(message: unknown): ConversationEntry[] {
  return toolParts(message).flatMap((part) => {
    if (part.tool !== "question" || !isRecord(part.state) || part.state.status !== "completed") return []
    const questions = isRecord(part.state.input) && Array.isArray(part.state.input.questions)
      ? part.state.input.questions
      : []
    const answers = isRecord(part.state.metadata) && Array.isArray(part.state.metadata.answers)
      ? part.state.metadata.answers
      : []
    return questions.flatMap((item, index): ConversationEntry[] => {
      if (!isRecord(item) || typeof item.question !== "string") return []
      const selected = Array.isArray(answers[index])
        ? answers[index].filter((answer: unknown): answer is string => typeof answer === "string")
        : []
      if (selected.length === 0) return []
      return [
        {
          kind: "question_answer",
          question: item.question.slice(0, MAX_MESSAGE_CHARS),
          answers: selected.map((answer) => answer.slice(0, MAX_MESSAGE_CHARS)),
        },
      ]
    })
  })
}

function directory(context: RuntimeContext): string | undefined {
  return context.location?.directory ?? context.data.location?.default().directory
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payload(event: Record<string, any>): Record<string, any> | null {
  return isRecord(event.data) ? event.data : isRecord(event.properties) ? event.properties : null
}

function validRequest(
  data: Record<string, any> | null,
  actionKey: "action" | "permission",
  resourcesKey: "resources" | "patterns",
): data is Record<string, any> & { id: string; sessionID: string } {
  return Boolean(
    data &&
      typeof data.id === "string" &&
      typeof data.sessionID === "string" &&
      typeof data[actionKey] === "string" &&
      Array.isArray(data[resourcesKey]) &&
      data[resourcesKey].every((item: unknown) => typeof item === "string"),
  )
}

function normalizeTool(value: unknown): { type: "tool"; messageID: string; callID: string } | undefined {
  if (!isRecord(value) || (value.type !== undefined && value.type !== "tool") || typeof value.messageID !== "string") {
    return undefined
  }
  const callID = typeof value.callID === "string" ? value.callID : value.id
  return typeof callID === "string" ? { type: "tool", messageID: value.messageID, callID } : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function userText(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined
  if (message.type === "user" && typeof message.text === "string") {
    return isPluginContinuation(message.text) ? undefined : message.text
  }
  if (!isRecord(message.info) || message.info.role !== "user" || !Array.isArray(message.parts)) return undefined
  const text = message.parts
    .filter(
      (part) =>
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.synthetic !== true &&
        part.ignored !== true,
    )
    .map((part) => part.text)
    .join("\n")
  return text && !isPluginContinuation(text) ? text : undefined
}

function isPluginContinuation(text: string): boolean {
  return text.trimStart().startsWith(AUTO_PERMISSIONS_MESSAGE_PREFIX)
}
