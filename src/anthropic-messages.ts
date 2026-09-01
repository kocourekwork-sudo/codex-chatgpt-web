import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { AppConfig } from "./config";
import { httpStatusFromTerminalError } from "./lib/errors";

type JsonRecord = Record<string, unknown>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface AnthropicMessageRequest extends JsonRecord {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  system?: string | unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  metadata?: { user_id?: unknown };
}

const MODEL_ROUTES = [
  ["claude-chatgpt-web-luna", "chatgpt-web/luna", "ChatGPT Web - Luna"],
  ["claude-chatgpt-web-think", "chatgpt-web/think", "ChatGPT Web - Think"],
  ["claude-chatgpt-web-light", "chatgpt-web/light", "ChatGPT Web - Instant"],
  ["claude-chatgpt-web-medium", "chatgpt-web/medium", "ChatGPT Web - Medium"],
  ["claude-chatgpt-web-high", "chatgpt-web/high", "ChatGPT Web - High"],
  ["claude-chatgpt-web-extra-high", "chatgpt-web/extra-high", "ChatGPT Web - Extra High"],
  ["claude-chatgpt-web-pro", "chatgpt-web/pro", "ChatGPT Web - Pro"],
] as const;

const ROUTE_BY_MODEL = new Map<string, string>(MODEL_ROUTES.map(([gateway, responses]) => [gateway, responses]));

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(part => {
    const item = record(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function contentBlocks(value: unknown): JsonRecord[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  const blocks: JsonRecord[] = [];
  for (const part of value) {
    const item = record(part);
    if (item) blocks.push(item);
  }
  return blocks;
}

function latestHumanMessageIndex(messages: AnthropicMessageRequest["messages"]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (contentBlocks(message.content).some(block => block.type !== "tool_result")) return index;
  }
  return -1;
}

function extractCwd(system: string, override?: string | null): string {
  const explicit = override?.trim();
  if (explicit && isAbsolute(explicit)) return resolve(explicit);
  const patterns = [
    /(?:Primary working directory|Working directory):\s*([^\r\n<]+)/i,
    /<cwd>\s*([^<]+?)\s*<\/cwd>/i,
  ];
  for (const pattern of patterns) {
    const match = system.match(pattern)?.[1]?.trim();
    if (match && isAbsolute(match)) return resolve(match);
  }
  return resolve(process.cwd());
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function environmentContext(cwd: string): string {
  const escaped = xml(cwd);
  return `<environment_context>\n  <cwd>${escaped}</cwd>\n  <filesystem><workspace_roots><root>${escaped}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n  <outer_harness>Claude Code executes and authorizes every local tool call.</outer_harness>\n</environment_context>`;
}

function inputContent(block: JsonRecord): JsonRecord | undefined {
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "input_text", text: block.text };
  }
  if (block.type !== "image") return undefined;
  const source = record(block.source);
  if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` };
  }
  if (source?.type === "url" && typeof source.url === "string") {
    return { type: "input_image", image_url: source.url };
  }
  return undefined;
}

function toolResultText(block: JsonRecord): string | JsonRecord[] {
  const content = block.content;
  if (typeof content === "string") return block.is_error === true ? `Tool error: ${content}` : content;
  const parts: JsonRecord[] = contentBlocks(content).flatMap<JsonRecord>(part => {
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "input_text", text: block.is_error === true ? `Tool error: ${part.text}` : part.text }];
    }
    return inputContent(part) ?? [];
  });
  return parts.length > 0 ? parts : block.is_error === true ? "Tool failed without output" : "";
}

function translateMessages(
  request: AnthropicMessageRequest,
  cwd: string,
  turnId: string,
): JsonRecord[] {
  const currentHuman = latestHumanMessageIndex(request.messages);
  const input: JsonRecord[] = [];
  request.messages.forEach((message, messageIndex) => {
    const blocks = contentBlocks(message.content);
    const itemMetadata = messageIndex === currentHuman ? { turn_id: turnId } : undefined;
    if (messageIndex === currentHuman) {
      input.push({
        type: "message",
        id: `msg_claude_environment_${turnId.slice(-16)}`,
        role: "user",
        content: [{ type: "input_text", text: environmentContext(cwd) }],
        internal_chat_message_metadata_passthrough: itemMetadata,
      });
    }

    const messageContent = blocks.flatMap(block => {
      if (block.type === "tool_result") return [];
      const translated = message.role === "user" ? inputContent(block) : (
        block.type === "text" && typeof block.text === "string"
          ? { type: "output_text", text: block.text }
          : undefined
      );
      return translated ?? [];
    });
    if (messageContent.length > 0) {
      input.push({
        type: "message",
        id: `msg_claude_${messageIndex}_${sha256(messageContent).slice(0, 16)}`,
        role: message.role,
        content: messageContent,
        ...(itemMetadata ? { internal_chat_message_metadata_passthrough: itemMetadata } : {}),
      });
    }

    for (const block of blocks) {
      if (message.role === "assistant" && block.type === "tool_use"
        && typeof block.id === "string" && typeof block.name === "string") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(record(block.input) ?? {}),
        });
      }
      if (message.role === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: toolResultText(block),
        });
      }
    }
  });
  return input;
}

function translateTools(value: unknown[] | undefined): JsonRecord[] {
  if (!value) return [];
  return value.flatMap(raw => {
    const tool = record(raw);
    if (!tool || typeof tool.name !== "string") return [];
    return [{
      type: "function",
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: record(tool.input_schema) ?? { type: "object", additionalProperties: true },
    }];
  });
}

function translateToolChoice(value: unknown): unknown {
  const choice = record(value);
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", name: choice.name };
  }
  return undefined;
}

function requireRequest(raw: unknown): AnthropicMessageRequest {
  const value = record(raw);
  if (!value || typeof value.model !== "string" || !Number.isFinite(value.max_tokens)
    || !Array.isArray(value.messages)) {
    throw new Error("Anthropic Messages request requires model, max_tokens, and messages");
  }
  return value as unknown as AnthropicMessageRequest;
}

export function isChatGptWebAnthropicModel(model: string): boolean {
  return ROUTE_BY_MODEL.has(model);
}

export function isAnthropicMessagesClient(req: Request): boolean {
  return req.headers.has("anthropic-version")
    || /(?:claude-code|anthropic)/i.test(req.headers.get("user-agent") ?? "");
}

export function anthropicModelCatalog(
  capabilities: Pick<AppConfig, "solAvailable" | "proAvailable"> = { solAvailable: true, proAvailable: true },
): JsonRecord {
  const allowed = capabilities.solAvailable
    ? new Set(capabilities.proAvailable
      ? ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro"]
      : ["chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high"])
    : new Set(["chatgpt-web/luna", "chatgpt-web/think"]);
  const data = MODEL_ROUTES.filter(([, route]) => allowed.has(route)).map(([id, , displayName]) => ({
    id,
    type: "model",
    display_name: displayName,
    created_at: "2026-08-31T00:00:00Z",
  }));
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}

export function anthropicToResponses(raw: unknown, cwdOverride?: string | null): {
  body: JsonRecord;
  requestedModel: string;
  threadId: string;
  turnId: string;
} {
  const request = requireRequest(raw);
  const responsesModel = ROUTE_BY_MODEL.get(request.model);
  if (!responsesModel) throw new Error(`Unsupported ChatGPT Web Claude model: ${request.model}`);
  const system = textBlocks(request.system);
  const cwd = extractCwd(system, cwdOverride);
  const currentHuman = latestHumanMessageIndex(request.messages);
  if (currentHuman < 0) throw new Error("Claude Code request has no current human message");
  const userId = typeof request.metadata?.user_id === "string" ? request.metadata.user_id : undefined;
  // Claude Code multiplexes several logically different model calls through one metadata.user_id
  // (main agent, lightweight helper/classifier calls, compaction, etc.). Using user_id alone made
  // those independent calls fight over one retained ChatGPT conversation. Keep user_id as the
  // outer session anchor, but add a stable lane signature from the system prompt and first message.
  // Tool continuations and later human messages keep the same lane; unrelated helpers do not.
  const threadSeed = {
    user_id: userId ?? null,
    system: system.slice(0, 4_096),
    first: request.messages[0] ?? null,
  };
  const threadId = `thread_claude_${sha256(threadSeed).slice(0, 32)}`;
  const turnId = `turn_claude_${sha256({ threadId, messages: request.messages.slice(0, currentHuman + 1) }).slice(0, 32)}`;
  const metadata = JSON.stringify({
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "none",
    workspaces: { [cwd]: {} },
  });
  const toolChoice = translateToolChoice(request.tool_choice);
  return {
    requestedModel: request.model,
    threadId,
    turnId,
    body: {
      model: responsesModel,
      instructions: system,
      input: translateMessages(request, cwd, turnId),
      tools: translateTools(request.tools),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      parallel_tool_calls: true,
      max_output_tokens: request.max_tokens,
      reasoning: { summary: "auto" },
      stream: request.stream === true,
      store: false,
      prompt_cache_key: threadId,
      client_metadata: { "x-codex-turn-metadata": metadata },
      metadata: { outer_harness: "claude-code" },
    },
  };
}

function outputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => {
    const item = record(part);
    return (item?.type === "output_text" || item?.type === "text") && typeof item.text === "string"
      ? [item.text]
      : [];
  }).join("");
}

function responsesContent(body: JsonRecord): JsonRecord[] {
  const output = Array.isArray(body.output) ? body.output : [];
  const content: JsonRecord[] = [];
  for (const raw of output) {
    const item = record(raw);
    if (!item) continue;
    if (item.type === "message") {
      const text = outputText(item.content);
      if (text) content.push({ type: "text", text });
    }
    if ((item.type === "function_call" || item.type === "custom_tool_call")
      && typeof item.call_id === "string" && typeof item.name === "string") {
      let input: unknown = {};
      if (item.type === "custom_tool_call") input = { input: typeof item.input === "string" ? item.input : "" };
      else if (typeof item.arguments === "string" && item.arguments.trim()) {
        try { input = JSON.parse(item.arguments); }
        catch { input = { input: item.arguments }; }
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    }
  }
  return content;
}

function anthropicUsage(body: JsonRecord): { input_tokens: number; output_tokens: number } {
  const usage = record(body.usage);
  const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  return { input_tokens: input, output_tokens: output };
}

export function responsesToAnthropic(body: JsonRecord, requestedModel: string): JsonRecord {
  const content = responsesContent(body);
  const usage = anthropicUsage(body);
  const hasToolUse = content.some(block => block.type === "tool_use");
  const incomplete = record(body.incomplete_details);
  return {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: hasToolUse ? "tool_use" : incomplete?.reason === "max_output_tokens" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage,
  };
}

function sseEvent(type: string, data: JsonRecord): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicSse(message: JsonRecord): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const content: JsonRecord[] = [];
  if (Array.isArray(message.content)) {
    for (const value of message.content) {
      const block = record(value);
      if (block) content.push(block);
    }
  }
  const usage = record(message.usage) ?? {};
  const chunks: string[] = [sseEvent("message_start", {
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 } },
  })];
  content.forEach((block, index) => {
    if (block.type === "text") {
      chunks.push(sseEvent("content_block_start", {
        type: "content_block_start", index, content_block: { type: "text", text: "" },
      }));
      chunks.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index, delta: { type: "text_delta", text: block.text ?? "" },
      }));
    } else if (block.type === "tool_use") {
      chunks.push(sseEvent("content_block_start", {
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      }));
      chunks.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      }));
    }
    chunks.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
  });
  chunks.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens ?? 0 },
  }));
  chunks.push(sseEvent("message_stop", { type: "message_stop" }));
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

interface ResponsesSseFrame {
  event?: string;
  data: string;
}

interface AnthropicStreamTrace {
  traceId: string;
  startedAt: number;
  firstUpstreamAt?: number;
  firstContentAt?: number;
}

function claudeTraceEnabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env.CODEX_CHATGPT_WEB_CLAUDE_TRACE ?? "");
}

function traceClaude(trace: AnthropicStreamTrace, phase: string, details: JsonRecord = {}): void {
  if (!claudeTraceEnabled()) return;
  console.error(`[claude-gateway] ${JSON.stringify({
    trace_id: trace.traceId,
    phase,
    elapsed_ms: Date.now() - trace.startedAt,
    ...details,
  })}`);
}

function requestSizeStats(raw: unknown, translatedBody: JsonRecord): JsonRecord {
  const value = record(raw);
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  const tools = Array.isArray(value?.tools) ? value.tools : [];
  return {
    request_chars: JSON.stringify(raw).length,
    translated_chars: JSON.stringify(translatedBody).length,
    system_chars: JSON.stringify(value?.system ?? "").length,
    messages_chars: JSON.stringify(messages).length,
    tools_chars: JSON.stringify(tools).length,
    message_count: messages.length,
    tool_count: tools.length,
  };
}

function parseSseFrame(rawFrame: string): ResponsesSseFrame | undefined {
  const lines = rawFrame.replaceAll("\r\n", "\n").split("\n");
  let event: string | undefined;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n") };
}

function responseUsage(response: JsonRecord | undefined): { inputTokens: number; outputTokens: number } {
  const usage = record(response?.usage);
  return {
    inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

function responseErrorMessage(response: JsonRecord | undefined, fallback: string): string {
  const error = record(response?.error) ?? record(response?.last_error);
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  const incomplete = record(response?.incomplete_details);
  if (typeof incomplete?.message === "string" && incomplete.message.trim()) return incomplete.message;
  if (typeof incomplete?.reason === "string" && incomplete.reason.trim()) return incomplete.reason;
  return fallback;
}

type AnthropicGatewayFailure = {
  status: number;
  type: string;
  message: string;
  retryable?: boolean;
  code?: string;
};

const ANTHROPIC_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "api_error",
  "overloaded_error",
]);

function responsesFailure(response: JsonRecord | undefined, fallback: string): AnthropicGatewayFailure {
  const error = record(response?.error) ?? record(response?.last_error);
  const incomplete = record(response?.incomplete_details);
  const message = responseErrorMessage(response, fallback);
  const sourceType = typeof error?.type === "string" ? error.type : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  const retryable = typeof response?.retryable === "boolean"
    ? response.retryable
    : typeof incomplete?.retryable === "boolean"
      ? incomplete.retryable
      : undefined;
  let status = httpStatusFromTerminalError({ type: sourceType, code, message });
  let type = sourceType && ANTHROPIC_ERROR_TYPES.has(sourceType)
    ? sourceType
    : status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 429
          ? "rate_limit_error"
          : status >= 500
            ? "api_error"
            : "invalid_request_error";

  // A browser UI failure marked non-retryable must stay non-retryable at the Anthropic boundary.
  // Claude Code automatically retries api_error/5xx responses; converting these deterministic
  // failures to 422 prevents minutes of replaying the same cached rejection. ChatGPT Web rate
  // limits are also fail-fast here: blindly re-sending browser turns makes the UI throttle worse,
  // so the user should retry manually after the account recovers.
  const browserRateLimit = status === 429 || type === "rate_limit_error" || code === "rate_limit_exceeded";
  if (retryable === false || browserRateLimit) {
    status = 422;
    type = "invalid_request_error";
  }
  return { status, type, message, ...(retryable !== undefined ? { retryable } : {}), ...(code ? { code } : {}) };
}

function anthropicFailurePayload(failure: AnthropicGatewayFailure): JsonRecord {
  return {
    type: "error",
    error: {
      type: failure.type,
      message: failure.message,
    },
  };
}

const CLAUDE_AUXILIARY_LANE_GRACE_MS = 100;
const claudeBrowserLaneTails = new Map<string, Promise<void>>();

function claudeBrowserLaneKey(raw: unknown, fallbackThreadId: string): string {
  const value = record(raw);
  const metadata = record(value?.metadata);
  return typeof metadata?.user_id === "string" && metadata.user_id.length > 0
    ? `user:${metadata.user_id}`
    : `thread:${fallbackThreadId}`;
}

function isClaudeAuxiliaryRequest(raw: unknown): boolean {
  const value = record(raw);
  const tools = Array.isArray(value?.tools) ? value.tools : [];
  return tools.length === 0;
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal.reason ?? new DOMException("Request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireClaudeBrowserLane(
  key: string,
  auxiliary: boolean,
  signal: AbortSignal,
): Promise<() => void> {
  // Claude Code commonly starts a tiny helper tens of milliseconds before the real tool-bearing
  // turn. Give that helper a short grace window so the primary request can acquire the lane first.
  if (auxiliary) await abortableDelay(CLAUDE_AUXILIARY_LANE_GRACE_MS, signal);
  const previous = claudeBrowserLaneTails.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolveGate => { releaseGate = resolveGate; });
  const tail = previous.catch(() => {}).then(() => gate);
  claudeBrowserLaneTails.set(key, tail);
  try {
    await Promise.race([
      previous.catch(() => {}),
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) { reject(signal.reason ?? new DOMException("Request aborted", "AbortError")); return; }
        const onAbort = () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        void previous.finally(() => signal.removeEventListener("abort", onAbort));
      }),
    ]);
  } catch (error) {
    // Remove an aborted waiter from the chain instead of leaving its gate locked forever.
    releaseGate();
    void tail.finally(() => {
      if (claudeBrowserLaneTails.get(key) === tail) claudeBrowserLaneTails.delete(key);
    });
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (claudeBrowserLaneTails.get(key) === tail) {
      void tail.finally(() => {
        if (claudeBrowserLaneTails.get(key) === tail) claudeBrowserLaneTails.delete(key);
      });
    }
  };
}

function streamedAnthropicMessageStart(requestedModel: string, inputTokens: number): JsonRecord {
  return {
    type: "message_start",
    message: {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  };
}

/**
 * Convert the local Responses SSE stream to Anthropic Messages SSE without buffering the turn.
 * Reasoning events are deliberately omitted: Claude Code only needs assistant text and tool calls,
 * and the local browser bridge must not expose hidden reasoning through the Anthropic surface.
 */
export function responsesSseToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  inputTokens: number,
  trace: AnthropicStreamTrace,
  onSettled?: () => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let cancelled = false;
  let closed = false;
  let terminal = false;
  let nextBlockIndex = 0;
  let sawToolUse = false;
  let lastEmitAt = Date.now();
  const blocksByOutput = new Map<number, {
    index: number;
    kind: "text" | "tool";
    emitted: string;
    closed: boolean;
    toolName?: string;
    toolId?: string;
  }>();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (type: string, data: JsonRecord) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseEvent(type, data)));
        lastEmitAt = Date.now();
      };
      const closeBlock = (outputIndex: number) => {
        const block = blocksByOutput.get(outputIndex);
        if (!block || block.closed) return;
        emit("content_block_stop", { type: "content_block_stop", index: block.index });
        block.closed = true;
      };
      const ensureTextBlock = (outputIndex: number) => {
        const existing = blocksByOutput.get(outputIndex);
        if (existing) return existing;
        const block = { index: nextBlockIndex++, kind: "text" as const, emitted: "", closed: false };
        blocksByOutput.set(outputIndex, block);
        emit("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "text", text: "" },
        });
        return block;
      };
      const ensureToolBlock = (outputIndex: number, item: JsonRecord) => {
        const existing = blocksByOutput.get(outputIndex);
        if (existing) return existing;
        const toolId = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `toolu_${randomUUID().replaceAll("-", "")}`;
        const toolName = typeof item.name === "string" ? item.name : "unknown_tool";
        const block = {
          index: nextBlockIndex++, kind: "tool" as const, emitted: "", closed: false,
          toolName, toolId,
        };
        blocksByOutput.set(outputIndex, block);
        sawToolUse = true;
        emit("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
        });
        return block;
      };
      const emitContentOnce = () => {
        if (trace.firstContentAt !== undefined) return;
        trace.firstContentAt = Date.now();
        traceClaude(trace, "first_content");
      };
      const emitTerminal = (stopReason: "end_turn" | "tool_use" | "max_tokens", outputTokens: number) => {
        if (terminal) return;
        for (const outputIndex of blocksByOutput.keys()) closeBlock(outputIndex);
        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        emit("message_stop", { type: "message_stop" });
        terminal = true;
        traceClaude(trace, "completed", { stop_reason: stopReason, output_tokens: outputTokens });
      };
      const emitStreamError = (failure: AnthropicGatewayFailure | string) => {
        if (terminal) return;
        const normalized = typeof failure === "string"
          ? { status: 502, type: "api_error", message: failure }
          : failure;
        emit("error", anthropicFailurePayload(normalized));
        terminal = true;
        traceClaude(trace, "failed", {
          message: normalized.message,
          error_type: normalized.type,
          status: normalized.status,
          ...(normalized.retryable !== undefined ? { retryable: normalized.retryable } : {}),
          ...(normalized.code ? { code: normalized.code } : {}),
        });
      };

      emit("message_start", streamedAnthropicMessageStart(requestedModel, inputTokens));
      traceClaude(trace, "anthropic_stream_open");

      const ping = setInterval(() => {
        if (closed || terminal || Date.now() - lastEmitAt < 5_000) return;
        emit("ping", { type: "ping" });
      }, 1_000);

      const handleFrame = (frame: ResponsesSseFrame) => {
        if (frame.data === "[DONE]") return;
        let data: JsonRecord;
        try {
          data = JSON.parse(frame.data) as JsonRecord;
        } catch {
          emitStreamError("Responses bridge emitted invalid SSE JSON");
          return;
        }
        const type = typeof data.type === "string" ? data.type : frame.event;
        if (!type) return;
        if (trace.firstUpstreamAt === undefined) {
          trace.firstUpstreamAt = Date.now();
          traceClaude(trace, "first_responses_event", { event: type });
        }

        const outputIndex = typeof data.output_index === "number" ? data.output_index : -1;
        switch (type) {
          case "response.heartbeat":
            emit("ping", { type: "ping" });
            return;
          case "response.content_part.added": {
            const part = record(data.part);
            if (outputIndex >= 0 && part?.type === "output_text") ensureTextBlock(outputIndex);
            return;
          }
          case "response.output_item.added": {
            const item = record(data.item);
            if (!item || outputIndex < 0) return;
            if (item.type === "function_call" || item.type === "custom_tool_call") ensureToolBlock(outputIndex, item);
            return;
          }
          case "response.output_text.delta": {
            if (outputIndex < 0 || typeof data.delta !== "string") return;
            const block = ensureTextBlock(outputIndex);
            if (block.closed || !data.delta) return;
            emit("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "text_delta", text: data.delta },
            });
            block.emitted += data.delta;
            emitContentOnce();
            return;
          }
          case "response.function_call_arguments.delta": {
            if (outputIndex < 0 || typeof data.delta !== "string") return;
            const block = blocksByOutput.get(outputIndex);
            if (!block || block.kind !== "tool" || block.closed || !data.delta) return;
            emit("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: data.delta },
            });
            block.emitted += data.delta;
            emitContentOnce();
            return;
          }
          case "response.output_item.done": {
            const item = record(data.item);
            if (!item || outputIndex < 0) return;
            if (item.type === "message") {
              const block = ensureTextBlock(outputIndex);
              const full = outputText(item.content);
              if (!block.closed && full.startsWith(block.emitted) && full.length > block.emitted.length) {
                const suffix = full.slice(block.emitted.length);
                emit("content_block_delta", {
                  type: "content_block_delta", index: block.index,
                  delta: { type: "text_delta", text: suffix },
                });
                block.emitted = full;
                emitContentOnce();
              }
              closeBlock(outputIndex);
              return;
            }
            if (item.type === "function_call") {
              const block = ensureToolBlock(outputIndex, item);
              const full = typeof item.arguments === "string" && item.arguments.trim() ? item.arguments : "{}";
              if (!block.closed && full.startsWith(block.emitted) && full.length > block.emitted.length) {
                const suffix = full.slice(block.emitted.length);
                emit("content_block_delta", {
                  type: "content_block_delta", index: block.index,
                  delta: { type: "input_json_delta", partial_json: suffix },
                });
                block.emitted = full;
                emitContentOnce();
              }
              closeBlock(outputIndex);
              return;
            }
            if (item.type === "custom_tool_call") {
              const block = ensureToolBlock(outputIndex, item);
              const json = JSON.stringify({ input: typeof item.input === "string" ? item.input : "" });
              if (!block.closed && block.emitted.length === 0) {
                emit("content_block_delta", {
                  type: "content_block_delta", index: block.index,
                  delta: { type: "input_json_delta", partial_json: json },
                });
                block.emitted = json;
                emitContentOnce();
              }
              closeBlock(outputIndex);
            }
            return;
          }
          case "response.completed": {
            const response = record(data.response);
            emitTerminal(sawToolUse ? "tool_use" : "end_turn", responseUsage(response).outputTokens);
            return;
          }
          case "response.incomplete": {
            const response = record(data.response);
            const details = record(response?.incomplete_details);
            const reason = typeof details?.reason === "string" ? details.reason : "incomplete_response";
            if (reason === "max_output_tokens") {
              emitTerminal("max_tokens", responseUsage(response).outputTokens);
            } else {
              emitStreamError(responsesFailure(
                response,
                `Responses bridge incomplete: ${responseErrorMessage(response, reason)}`,
              ));
            }
            return;
          }
          case "response.failed": {
            const response = record(data.response);
            emitStreamError(responsesFailure(response, "Responses bridge failed"));
            return;
          }
        }
      };

      const pump = async () => {
        try {
          while (!cancelled && !terminal) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const rawFrame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const frame = parseSseFrame(rawFrame);
              if (frame) handleFrame(frame);
              if (terminal) break;
            }
          }
          if (!terminal && !cancelled) emitStreamError("Responses stream closed before a terminal event");
        } catch (error) {
          if (!cancelled) emitStreamError(error instanceof Error ? error.message : String(error));
        } finally {
          clearInterval(ping);
          try { await reader.cancel(); } catch { /* best effort */ }
          if (!closed) {
            controller.close();
            closed = true;
          }
          onSettled?.();
        }
      };
      void pump();
    },
    async cancel(reason) {
      cancelled = true;
      traceClaude(trace, "client_cancelled");
      try { await reader.cancel(reason); } catch { /* best effort */ }
    },
  });
}

function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function anthropicFailureResponse(failure: AnthropicGatewayFailure): Response {
  return Response.json(anthropicFailurePayload(failure), { status: failure.status });
}

export async function anthropicMessagesRequest(
  req: Request,
  config: AppConfig,
  runResponses: (request: Request, config: AppConfig) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  let raw: unknown;
  try { raw = await req.json(); }
  catch { return anthropicError(400, "invalid_request_error", "Request body must be valid JSON"); }
  const model = record(raw)?.model;
  if (typeof model !== "string") return anthropicError(400, "invalid_request_error", "model is required");
  if (!isChatGptWebAnthropicModel(model)) {
    try { return await forwardAnthropicRequest(req, raw); }
    catch (error) {
      return anthropicError(502, "api_error", error instanceof Error ? error.message : String(error));
    }
  }

  let translated: ReturnType<typeof anthropicToResponses>;
  try { translated = anthropicToResponses(raw, req.headers.get("x-chatgpt-web-cwd")); }
  catch (error) {
    return anthropicError(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const trace: AnthropicStreamTrace = {
    traceId: translated.turnId,
    startedAt,
  };
  traceClaude(trace, "translated", {
    model: translated.requestedModel,
    thread_id: translated.threadId,
    stream: record(raw)?.stream === true,
    ...requestSizeStats(raw, translated.body),
  });
  const laneKey = claudeBrowserLaneKey(raw, translated.threadId);
  const auxiliary = isClaudeAuxiliaryRequest(raw);
  const laneWaitStartedAt = Date.now();
  let releaseLane: (() => void) | undefined;
  try {
    releaseLane = await acquireClaudeBrowserLane(laneKey, auxiliary, req.signal);
  } catch (error) {
    if (req.signal.aborted) {
      return anthropicError(499, "invalid_request_error", "Claude Code cancelled the queued ChatGPT Web request");
    }
    return anthropicError(502, "api_error", error instanceof Error ? error.message : String(error));
  }
  traceClaude(trace, "browser_lane_acquired", {
    lane_wait_ms: Date.now() - laneWaitStartedAt,
    auxiliary,
  });

  let laneTransferredToStream = false;
  try {
    const internal = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(translated.body),
      signal: req.signal,
    });
    const response = await runResponses(internal, config);
    traceClaude(trace, "responses_headers", {
      status: response.status,
      content_type: response.headers.get("content-type") ?? "",
    });

    if (record(raw)?.stream === true) {
      if (!response.ok) {
        let source: JsonRecord | undefined;
        try { source = record(await response.json()); } catch { /* invalid error body */ }
        const failure = responsesFailure(source, "Responses bridge failed before streaming");
        if (failure.status === 502 && response.status !== 200) failure.status = response.status;
        return anthropicFailureResponse(failure);
      }
      if (!response.body) return anthropicError(502, "api_error", "Responses bridge returned no stream body");
      const contentType = response.headers.get("content-type") ?? "";
      if (!/text\/event-stream/i.test(contentType)) {
        let responseBody: JsonRecord;
        try { responseBody = await response.json() as JsonRecord; }
        catch { return anthropicError(502, "api_error", "Responses bridge returned neither SSE nor valid JSON"); }
        if (responseBody.status === "failed" || record(responseBody.error)) {
          return anthropicFailureResponse(responsesFailure(responseBody, "Responses bridge failed"));
        }
        const message = responsesToAnthropic(responseBody, translated.requestedModel);
        return new Response(anthropicSse(message), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      }
      laneTransferredToStream = true;
      const releaseStreamLane = releaseLane;
      return new Response(responsesSseToAnthropic(
        response.body,
        translated.requestedModel,
        approximateInputTokens(raw),
        trace,
        releaseStreamLane,
      ), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    let responseBody: JsonRecord;
    try { responseBody = await response.json() as JsonRecord; }
    catch { return anthropicError(502, "api_error", "Responses bridge returned invalid JSON"); }
    if (!response.ok || responseBody.status === "failed" || record(responseBody.error)) {
      const failure = responsesFailure(responseBody, "Responses bridge failed");
      if (failure.status === 502 && response.status !== 200) failure.status = response.status;
      return anthropicFailureResponse(failure);
    }
    const message = responsesToAnthropic(responseBody, translated.requestedModel);
    traceClaude(trace, "completed_nonstream");
    return Response.json(message);
  } finally {
    if (!laneTransferredToStream) releaseLane?.();
  }
}

function approximateInputTokens(raw: unknown): number {
  const value = record(raw);
  const prompt = JSON.stringify({
    system: value?.system ?? "",
    messages: value?.messages ?? [],
    tools: value?.tools ?? [],
  });
  // The browser backend does not expose a tokenizer. A conservative character estimate is
  // sufficient for Claude Code's local budget checks; the real model response remains authoritative.
  return Math.max(1, Math.ceil(prompt.length / 3.5));
}

export async function anthropicCountTokensRequest(req: Request): Promise<Response> {
  let raw: unknown;
  try { raw = await req.json(); }
  catch { return anthropicError(400, "invalid_request_error", "Request body must be valid JSON"); }
  const model = record(raw)?.model;
  if (typeof model !== "string") return anthropicError(400, "invalid_request_error", "model is required");
  if (isChatGptWebAnthropicModel(model)) {
    return Response.json({ input_tokens: approximateInputTokens(raw) });
  }
  try { return await forwardAnthropicRequest(req, raw, fetch, "/v1/messages/count_tokens"); }
  catch (error) {
    return anthropicError(502, "api_error", error instanceof Error ? error.message : String(error));
  }
}

export async function forwardAnthropicRequest(
  req: Request,
  raw: unknown,
  fetchImpl: FetchLike = fetch,
  pathname = "/v1/messages",
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  const query = new URL(req.url).search;
  const response = await fetchImpl(`https://api.anthropic.com${pathname}${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify(raw),
    signal: req.signal,
  });
  // Bun/undici transparently decompresses fetch responses but can retain the upstream encoding
  // header. Returning that header makes Claude Code attempt a second Brotli/gzip decode.
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
