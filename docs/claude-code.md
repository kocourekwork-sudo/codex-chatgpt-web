# Claude Code gateway (experimental)

The daemon can expose ChatGPT Web models through the Anthropic Messages API used by native Claude
Code. The selected Web route appears in the normal `/model` picker in the CLI and VS Code extension.

This integration is experimental. The normal Codex integration remains unchanged.

## Configure Claude Code

Start the `codex-chatgpt-web` launcher and finish its browser login first. Then merge this into the
Claude Code user settings file (`~/.claude/settings.json`; on Windows, `%USERPROFILE%\.claude\settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:17841",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "claude-chatgpt-web-high",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "ChatGPT Web",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "ChatGPT Web through the local Codex bridge"
  }
}
```

Do not add a dummy `ANTHROPIC_API_KEY`. Claude Code treats an API key as an instruction to stop
using the logged-in Claude subscription. Existing Claude authentication headers are passed through
only when a native Claude model is selected.

Restart Claude Code or the VS Code extension, then run `/model`. `ChatGPT Web` appears alongside
the built-in Sonnet, Opus, and Haiku choices. Change the suffix to select the Web route your ChatGPT
account supports:

- Free: `luna` or `think`;
- Plus: `light`, `medium`, or `high`;
- Pro: also `extra-high` or `pro`.

This single custom entry is the recommended subscription-safe configuration. Claude Code can also
discover every available route from `GET /v1/models` on version 2.1.129 or newer by setting
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. Discovery authentication currently relies on
`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, so it may not run when Claude Code is using only its
Claude Pro/Max OAuth login. Do not add a dummy credential just to enable discovery.

The gateway model IDs are prefixed with `claude-` because Claude Code only discovers gateway model
IDs beginning with `claude` or `anthropic`.

## Verify discovery

```powershell
Invoke-RestMethod http://127.0.0.1:17841/v1/models `
  -Headers @{ "anthropic-version" = "2023-06-01" }
```

## Routing

- `claude-chatgpt-web-*` requests are translated to the local Responses bridge and ChatGPT browser.
- Other model IDs are forwarded to `https://api.anthropic.com/v1/messages` with the incoming
  authentication and Anthropic feature headers intact, allowing the same picker to switch back to
  Sonnet or Opus.
- Claude Code remains the outer harness. It executes and authorizes filesystem, shell, edit, and MCP
  tools. Tool calls cross the gateway as native Anthropic `tool_use` / `tool_result` blocks.

## Current limitations

- ChatGPT Web turns are relayed to Claude Code as real Anthropic SSE: the gateway emits
  `message_start` immediately, forwards text/tool deltas as they arrive, and sends heartbeat pings
  while the browser is still working. This removes the old full-turn buffering layer; browser DOM
  acquisition and ChatGPT generation latency still remain upstream of the first content delta.
- Claude Code can issue lightweight helper calls alongside the main tool-bearing turn. The gateway
  gives the primary turn a short priority window and serializes browser work per Claude session so
  those calls do not hammer the same ChatGPT account concurrently. Independent helper prompts use
  separate retained ChatGPT conversation identities even when Claude reuses one metadata `user_id`.
- ChatGPT browser rate limits and deterministic browser-UI integrity failures are surfaced fail-fast
  to Claude Code instead of being advertised as generic retryable `api_error` failures. Retry a real
  ChatGPT rate limit manually after the web account recovers.
- The `/model` picker and a real Messages request have been validated with signed-in Claude Code
  2.1.251. Native Claude passthrough, compaction, resumed sessions, and subagents still need broader
  live validation.
- The working directory is read from Claude Code's system prompt. `X-ChatGPT-Web-Cwd` can explicitly
  override it for diagnostics.
- ChatGPT Web browser automation remains unofficial and can break when the website changes.

## Diagnose a slow turn

Set `CODEX_CHATGPT_WEB_CLAUDE_TRACE=1` in the launcher/daemon environment and restart the launcher.
The daemon then writes one-line JSON timing records to stderr without logging prompt or tool
contents. Useful fields include request/system/message/tool character counts and these phases:

- `translated`: request translation finished and reports payload sizes;
- `browser_lane_acquired`: the request acquired its per-Claude-session browser lane and reports queue wait;
- `responses_headers`: the local Responses bridge returned its HTTP/SSE surface;
- `anthropic_stream_open`: Claude Code can already receive the Anthropic stream;
- `first_responses_event`: the first event arrived from the local Responses stream;
- `first_content`: the first model text or tool argument reached Claude Code;
- `completed` / `failed` / `client_cancelled`: terminal state and total elapsed time.

For a latency report, capture the `[claude-gateway]` lines for one fast first turn and the following
slow turn. The trace contains only hashes/IDs, sizes, timings, model IDs, statuses, and failure
messages; it does not print the prompt itself.
