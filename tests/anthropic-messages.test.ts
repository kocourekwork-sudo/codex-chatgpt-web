import { describe, expect, test } from "bun:test";
import {
  anthropicCountTokensRequest,
  anthropicMessagesRequest,
  anthropicModelCatalog,
  anthropicSse,
  anthropicToResponses,
  forwardAnthropicRequest,
  isAnthropicMessagesClient,
  responsesToAnthropic,
} from "../src/anthropic-messages";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

function metadata(body: Record<string, unknown>): Record<string, unknown> {
  const client = body.client_metadata as Record<string, unknown>;
  return JSON.parse(client["x-codex-turn-metadata"] as string) as Record<string, unknown>;
}

const baseRequest = {
  model: "claude-chatgpt-web-pro",
  max_tokens: 4_096,
  system: [{ type: "text", text: "You are Claude Code.\nPrimary working directory: C:\\repo" }],
  messages: [{ role: "user", content: [{ type: "text", text: "Inspect package.json" }] }],
  tools: [{
    name: "Read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  }],
};

describe("Claude Code model discovery", () => {
  test("publishes picker-safe Claude-prefixed ChatGPT Web models", () => {
    const catalog = anthropicModelCatalog();
    const ids = (catalog.data as Array<{ id: string }>).map(model => model.id);
    expect(ids).toEqual([
      "claude-chatgpt-web-light", "claude-chatgpt-web-medium", "claude-chatgpt-web-high",
      "claude-chatgpt-web-extra-high", "claude-chatgpt-web-pro",
    ]);
    expect(ids.every(id => id.startsWith("claude"))).toBe(true);
  });

  test("matches the picker to the signed-in ChatGPT account", () => {
    const luna = anthropicModelCatalog({ solAvailable: false, proAvailable: false });
    expect((luna.data as Array<{ id: string }>).map(model => model.id)).toEqual([
      "claude-chatgpt-web-luna", "claude-chatgpt-web-think",
    ]);
    const plus = anthropicModelCatalog({ solAvailable: true, proAvailable: false });
    expect((plus.data as Array<{ id: string }>).map(model => model.id)).toEqual([
      "claude-chatgpt-web-light", "claude-chatgpt-web-medium", "claude-chatgpt-web-high",
    ]);
  });

  test("recognizes Anthropic protocol clients without inspecting secrets", () => {
    expect(isAnthropicMessagesClient(new Request("http://localhost/v1/models", {
      headers: { "anthropic-version": "2023-06-01" },
    }))).toBe(true);
    expect(isAnthropicMessagesClient(new Request("http://localhost/v1/models"))).toBe(false);
  });
});

describe("Anthropic Messages to Responses", () => {
  test("preserves Claude Code streaming all the way to the Responses bridge", () => {
    const translated = anthropicToResponses({ ...baseRequest, stream: true });
    expect(translated.body.stream).toBe(true);
  });

  test("keeps one turn identity across tool continuations", () => {
    const first = anthropicToResponses(baseRequest);
    const continuation = anthropicToResponses({
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "package.json" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }],
        },
      ],
    });

    expect(first.body.model).toBe("chatgpt-web/pro");
    expect(metadata(first.body).thread_id).toBe(metadata(continuation.body).thread_id);
    expect(metadata(first.body).turn_id).toBe(metadata(continuation.body).turn_id);
    expect(continuation.body.input).toContainEqual({
      type: "function_call",
      call_id: "toolu_1",
      name: "Read",
      arguments: JSON.stringify({ file_path: "package.json" }),
    });
    expect(continuation.body.input).toContainEqual({
      type: "function_call_output",
      call_id: "toolu_1",
      output: "{}",
    });
  });

  test("separates Claude helper lanes that share one metadata user id", () => {
    const primary = anthropicToResponses({
      ...baseRequest,
      metadata: { user_id: "claude-session-1" },
    });
    const helper = anthropicToResponses({
      ...baseRequest,
      metadata: { user_id: "claude-session-1" },
      system: [{ type: "text", text: "Classify this request briefly" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
    });

    expect(metadata(primary.body).thread_id).not.toBe(metadata(helper.body).thread_id);
  });

  test("starts a new turn for a later human message", () => {
    const first = anthropicToResponses(baseRequest);
    const next = anthropicToResponses({
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        { role: "assistant", content: [{ type: "text", text: "Done" }] },
        { role: "user", content: [{ type: "text", text: "Now run tests" }] },
      ],
    });
    expect(metadata(first.body).thread_id).toBe(metadata(next.body).thread_id);
    expect(metadata(first.body).turn_id).not.toBe(metadata(next.body).turn_id);
  });

  test("injects a trusted environment immediately before the current instruction", () => {
    const translated = anthropicToResponses(baseRequest);
    const input = translated.body.input as Array<Record<string, unknown>>;
    const environment = input.findIndex(item => JSON.stringify(item).includes("<environment_context>"));
    const instruction = input.findIndex(item => JSON.stringify(item).includes("Inspect package.json"));
    expect(environment).toBeGreaterThanOrEqual(0);
    expect(instruction).toBe(environment + 1);
    expect(JSON.stringify(input[environment])).toContain("C:\\\\repo");
  });
});

describe("Responses to Anthropic Messages", () => {
  test("maps text and tool calls to native Claude content blocks", () => {
    const result = responsesToAnthropic({
      output: [
        { type: "message", content: [{ type: "output_text", text: "I will inspect it." }] },
        { type: "function_call", call_id: "call_1", name: "Read", arguments: "{\"file_path\":\"package.json\"}" },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    }, "claude-chatgpt-web-high");
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "text", text: "I will inspect it." },
      { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "package.json" } },
    ]);
  });

  test("emits a complete Anthropic streaming event sequence", async () => {
    const message = responsesToAnthropic({
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }, "claude-chatgpt-web-light");
    const text = await new Response(anthropicSse(message)).text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta","text":"Hello"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  test("relays Responses text deltas before the browser turn completes", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let internalBody: Record<string, unknown> | undefined;
    const response = await anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...baseRequest, stream: true }),
    }), defaultConfig("browser-only"), async request => {
      internalBody = await request.clone().json() as Record<string, unknown>;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { upstream = controller; },
      }), { headers: { "content-type": "text/event-stream" } });
    });

    expect(internalBody?.stream).toBe(true);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    const firstText = decoder.decode(first.value);
    expect(firstText).toContain("event: message_start");

    const frame = (event: string, data: Record<string, unknown>) => encoder.encode(
      `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`,
    );
    upstream.enqueue(frame("response.content_part.added", {
      output_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }));
    upstream.enqueue(frame("response.output_text.delta", { output_index: 0, delta: "Hello" }));

    const delta = await reader.read();
    const deltaText = decoder.decode(delta.value);
    expect(deltaText).toContain("content_block_start");
    let streamed = deltaText;
    while (!streamed.includes('"text":"Hello"')) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      streamed += decoder.decode(next.value);
    }
    expect(streamed).toContain('"type":"text_delta","text":"Hello"');

    upstream.enqueue(frame("response.output_item.done", {
      output_index: 0,
      item: {
        type: "message", id: "msg_1", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      },
    }));
    upstream.enqueue(frame("response.completed", {
      response: { status: "completed", usage: { input_tokens: 12, output_tokens: 1 } },
    }));
    upstream.enqueue(encoder.encode("data: [DONE]\n\n"));
    upstream.close();

    let tail = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      tail += decoder.decode(next.value);
    }
    expect(tail).toContain('"stop_reason":"end_turn"');
    expect(tail).toContain("event: message_stop");
  });

  test("streams tool arguments and terminates the Claude turn as tool_use", async () => {
    const encoder = new TextEncoder();
    const response = await anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...baseRequest, stream: true }),
    }), defaultConfig("browser-only"), async () => {
      const frame = (event: string, data: Record<string, unknown>) =>
        `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
      return new Response([
        frame("response.output_item.added", {
          output_index: 0,
          item: { type: "function_call", id: "fc_1", call_id: "toolu_1", name: "Read", arguments: "", status: "in_progress" },
        }),
        frame("response.function_call_arguments.delta", { output_index: 0, delta: '{"file_path":"package.json"}' }),
        frame("response.output_item.done", {
          output_index: 0,
          item: { type: "function_call", id: "fc_1", call_id: "toolu_1", name: "Read", arguments: '{"file_path":"package.json"}', status: "completed" },
        }),
        frame("response.completed", { response: { status: "completed", usage: { input_tokens: 20, output_tokens: 5 } } }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const text = await response.text();
    expect(text).toContain('"type":"tool_use","id":"toolu_1","name":"Read"');
    expect(text).toContain('"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"package.json\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).not.toContain("response.function_call_arguments.delta");
    expect(encoder.encode(text).byteLength).toBeGreaterThan(0);
  });

  test("does not misreport a stalled browser stream as a successful Claude turn", async () => {
    const response = await anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...baseRequest, stream: true }),
    }), defaultConfig("browser-only"), async () => new Response(
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"upstream_stall_timeout"}}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).toContain("upstream_stall_timeout");
    expect(text).not.toContain('"stop_reason":"end_turn"');
  });

  test("does not tell Claude Code to retry a deterministic browser UI failure", async () => {
    const response = await anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...baseRequest, stream: true }),
    }), defaultConfig("browser-only"), async () => new Response(
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","retryable":false,"error":{"type":"server_error","code":"prompt_attachment_integrity","message":"ChatGPT composer rejected the plain-text editing command"}}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const text = await response.text();
    expect(text).toContain('"type":"invalid_request_error"');
    expect(text).toContain("ChatGPT composer rejected the plain-text editing command");
    expect(text).not.toContain('"type":"api_error"');
  });

  test("fails ChatGPT browser rate limits fast instead of asking Claude Code to hammer retries", async () => {
    const response = await anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...baseRequest, stream: true }),
    }), defaultConfig("browser-only"), async () => new Response(
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","retryable":true,"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"ChatGPT rate limit: too many requests"}}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    const text = await response.text();
    expect(text).toContain('"type":"invalid_request_error"');
    expect(text).toContain("ChatGPT rate limit: too many requests");
    expect(text).not.toContain('"type":"rate_limit_error"');
  });
});

test("serializes one Claude session and lets the tool-bearing primary turn overtake a tiny helper", async () => {
  const calls: number[] = [];
  const completed = () => Response.json({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const helperRequest = {
    ...baseRequest,
    metadata: { user_id: "priority-session" },
    system: [{ type: "text", text: "helper" }],
    messages: [{ role: "user", content: [{ type: "text", text: "classify" }] }],
    tools: [],
    stream: false,
  };
  const primaryRequest = {
    ...baseRequest,
    metadata: { user_id: "priority-session" },
    stream: false,
  };
  const run = async (raw: unknown) => anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(raw),
  }), defaultConfig("browser-only"), async request => {
    const body = await request.json() as { tools?: unknown[] };
    calls.push(body.tools?.length ?? 0);
    return completed();
  });

  const helper = run(helperRequest);
  await new Promise(resolve => setTimeout(resolve, 20));
  const primary = run(primaryRequest);
  await Promise.all([helper, primary]);
  expect(calls).toEqual([1, 0]);
});

test("non-stream deterministic failures use a non-retryable HTTP status", async () => {
  const response = await anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...baseRequest, stream: false }),
  }), defaultConfig("browser-only"), async () => Response.json({
    status: "failed",
    retryable: false,
    error: {
      type: "server_error",
      code: "prompt_attachment_integrity",
      message: "ChatGPT composer rejected the plain-text editing command",
    },
  }));
  expect(response.status).toBe(422);
  const body = await response.json() as { error: { type: string } };
  expect(body.error.type).toBe("invalid_request_error");
});

test("native Claude models are forwarded without exposing or rewriting auth headers", async () => {
  let captured: Request | undefined;
  const response = await forwardAnthropicRequest(new Request("http://127.0.0.1:17841/v1/messages?beta=true", {
    method: "POST",
    headers: { authorization: "Bearer secret", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6" }),
  }), { model: "claude-sonnet-4-6" }, async (input, init) => {
    captured = new Request(input, init);
    return new Response('{"ok":true}', {
      headers: { "content-type": "application/json", "content-encoding": "br", "content-length": "11" },
    });
  });
  expect(response.ok).toBe(true);
  expect(captured?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  expect(captured?.headers.get("authorization")).toBe("Bearer secret");
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("content-length")).toBeNull();
});

test("counts ChatGPT Web input locally without sending the prompt upstream", async () => {
  const response = await anthropicCountTokensRequest(new Request("http://127.0.0.1/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseRequest),
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { input_tokens: number };
  expect(body.input_tokens).toBeGreaterThan(1);
});

test("surfaces a failed Responses body as an Anthropic API error", async () => {
  const response = await anthropicMessagesRequest(new Request("http://127.0.0.1/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseRequest),
  }), defaultConfig("browser-only"), async () => Response.json({
    status: "failed",
    error: { message: "browser broker unavailable" },
  }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    type: "error",
    error: { type: "api_error", message: "browser broker unavailable" },
  });
});

test("the shared daemon serves Claude Code discovery without calling the Codex catalog", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, solAvailable: true, proAvailable: false };
  const server = startServer(config, {
    fetchUpstream: async () => { throw new Error("Codex catalog must not run for Claude discovery"); },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map(model => model.id)).toEqual([
      "claude-chatgpt-web-light", "claude-chatgpt-web-medium", "claude-chatgpt-web-high",
    ]);
  } finally {
    await server.stop(true);
  }
});
