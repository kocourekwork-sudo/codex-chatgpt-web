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

- The first implementation buffers one browser round before emitting a valid Anthropic SSE event
  sequence. Tool loops work round by round, but token-level live streaming is not implemented yet.
- The `/model` picker and a real Messages request have been validated with signed-in Claude Code
  2.1.251. Native Claude passthrough, compaction, resumed sessions, and subagents still need broader
  live validation.
- The working directory is read from Claude Code's system prompt. `X-ChatGPT-Web-Cwd` can explicitly
  override it for diagnostics.
- ChatGPT Web browser automation remains unofficial and can break when the website changes.
