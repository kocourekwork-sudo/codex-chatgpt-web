import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { AppConfig } from "./config";

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
} {
  const request = requireRequest(raw);
  const responsesModel = ROUTE_BY_MODEL.get(request.model);
  if (!responsesModel) throw new Error(`Unsupported ChatGPT Web Claude model: ${request.model}`);
  const system = textBlocks(request.system);
  const cwd = extractCwd(system, cwdOverride);
  const currentHuman = latestHumanMessageIndex(request.messages);
  if (currentHuman < 0) throw new Error("Claude Code request has no current human message");
  const userId = typeof request.metadata?.user_id === "string" ? request.metadata.user_id : undefined;
  const threadSeed = userId ?? {
    system: system.slice(0, 4_096),
    first: request.messages[0],
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
    body: {
      model: responsesModel,
      instructions: system,
      input: translateMessages(request, cwd, turnId),
      tools: translateTools(request.tools),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      parallel_tool_calls: true,
      max_output_tokens: request.max_tokens,
      reasoning: { summary: "auto" },
      stream: false,
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

function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

export async function anthropicMessagesRequest(
  req: Request,
  config: AppConfig,
  runResponses: (request: Request, config: AppConfig) => Promise<Response>,
): Promise<Response> {
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
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(translated.body),
    signal: req.signal,
  });
  const response = await runResponses(internal, config);
  let responseBody: JsonRecord;
  try { responseBody = await response.json() as JsonRecord; }
  catch { return anthropicError(502, "api_error", "Responses bridge returned invalid JSON"); }
  if (!response.ok || responseBody.status === "failed" || record(responseBody.error)) {
    const source = record(responseBody.error);
    return anthropicError(response.ok ? 502 : response.status, "api_error", typeof source?.message === "string" ? source.message : "Responses bridge failed");
  }
  const message = responsesToAnthropic(responseBody, translated.requestedModel);
  if (record(raw)?.stream === true) {
    return new Response(anthropicSse(message), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }
  return Response.json(message);
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
  const response = await fetchImpl(`https://api.anthropic.com${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(raw),
    signal: req.signal,
  });
  return response;
}
