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
});

test("native Claude models are forwarded without exposing or rewriting auth headers", async () => {
  let captured: Request | undefined;
  const response = await forwardAnthropicRequest(new Request("http://127.0.0.1:17841/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer secret", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6" }),
  }), { model: "claude-sonnet-4-6" }, async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true });
  });
  expect(response.ok).toBe(true);
  expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
  expect(captured?.headers.get("authorization")).toBe("Bearer secret");
});

test("counts ChatGPT Web input locally without sending the prompt upstream", async () => {
  const response = await anthropicCountTokensRequest(new Request("http://127.0.0.1/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseRequest),
  }));
  expect(response.status).toBe(502);
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
  expect(response.status).toBe(200);
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
