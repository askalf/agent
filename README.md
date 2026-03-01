# @askalf/agent

**Open source computer-use agent — control your computer with natural language.**

One command to install. Bring your own Anthropic API key or Claude subscription. Full computer control: mouse, keyboard, screenshots, browser, terminal.

## Install

```bash
npm i -g @askalf/agent
```

Requires Node.js 20+.

## Quick Start

```bash
# 1. Authenticate
askalf-agent auth

# 2. Run
askalf-agent run "open Chrome and search for flights to Tokyo"
```

## Authentication

Two modes — choose based on how you want to pay:

### API Key (SDK Mode)

Paste your Anthropic API key (`sk-ant-...`). Pay per use. Uses the Anthropic SDK directly with the `computer_20251124` tool for full computer control.

```bash
askalf-agent auth
# Select "API Key" → paste your key
```

### Claude OAuth (CLI Mode)

Use your existing Claude Pro/Team subscription. Requires the [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed. Launches a local MCP server with computer control tools.

```bash
npm i -g @anthropic-ai/claude-code
claude auth login
askalf-agent auth
# Select "Claude OAuth"
```

## Commands

### `askalf-agent run "<prompt>"`

Run the agent with a natural language instruction.

```bash
askalf-agent run "resize all images in ./assets to 800px wide"
askalf-agent run "open VS Code, create a new file called app.py, and write a Flask hello world"
askalf-agent run "go to github.com and star the askalf/agent repo"
```

Options:
- `-m, --model <model>` — Model to use (default: `claude-sonnet-4-6`)
- `-b, --budget <amount>` — Max budget in USD (default: `1.00`)
- `-t, --turns <count>` — Max turns (default: `50`)

### `askalf-agent auth`

Configure authentication interactively.

- `askalf-agent auth --status` — Show current auth status

### `askalf-agent check`

Verify platform dependencies are installed.

```bash
$ askalf-agent check

Platform Check
──────────────────

Platform: win32
Display: win32

✔ Screenshot: powershell
✔ Mouse control: powershell
✔ Keyboard control: powershell
✔ Claude CLI: installed

✔ All dependencies available!
```

### `askalf-agent config`

View or update configuration.

```bash
askalf-agent config --model claude-opus-4-6 --budget 5.00
```

## Platform Dependencies

| OS | Required | Install |
|----|----------|---------|
| **macOS** | `cliclick` | `brew install cliclick` |
| **Linux (X11)** | `xdotool`, `scrot` | `sudo apt install xdotool scrot` |
| **Linux (Wayland)** | `ydotool`, `grim` | `sudo apt install ydotool grim` |
| **Windows** | PowerShell 5.1+ | Pre-installed |

Run `askalf-agent check` to see what's installed and what's missing.

## How It Works

### SDK Mode (API Key)

Uses the Anthropic SDK directly with the `computer_20251124` beta tool:

1. Captures a screenshot of your screen
2. Sends it to Claude with your prompt
3. Claude responds with computer actions (click, type, scroll, etc.)
4. Actions are executed via platform-native tools
5. New screenshot is captured and sent back
6. Loop continues until the task is complete or budget is reached

### CLI Mode (Claude OAuth)

Spawns the Claude CLI with a local MCP server that provides computer control tools:

1. Starts a local MCP server exposing screenshot, mouse, keyboard, and scroll tools
2. Passes the MCP config to `claude` CLI
3. Claude CLI calls the MCP tools to interact with your computer
4. Same capabilities as SDK mode, powered by your Claude subscription

## Configuration

Config is stored at `~/.askalf/config.json`:

```json
{
  "authMode": "api_key",
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-4-6",
  "maxBudgetUsd": 1.00,
  "maxTurns": 50
}
```

## Architecture

```
askalf-agent run "task"
    │
    ├── API Key? ──→ SDK Mode
    │                   │
    │                   ├── Anthropic SDK
    │                   ├── computer_20251124 tool
    │                   ├── bash_20250124 tool
    │                   └── text_editor tool
    │
    └── OAuth? ────→ CLI Mode
                        │
                        ├── Local MCP Server (stdio)
                        │   ├── screenshot
                        │   ├── mouse_click / mouse_move
                        │   ├── keyboard_type / keyboard_key
                        │   └── scroll
                        │
                        └── claude CLI --mcp-config
```

Both modes use the same cross-platform control layer:

| Action | macOS | Linux (X11) | Linux (Wayland) | Windows |
|--------|-------|-------------|-----------------|---------|
| Screenshot | `screencapture` | `scrot` | `grim` | PowerShell |
| Mouse | `cliclick` | `xdotool` | `ydotool` | PowerShell |
| Keyboard | `cliclick` | `xdotool` | `ydotool` | `SendKeys` |

## Full Platform

This CLI is a standalone agent for individual use. For multi-agent orchestration, scheduling, cost controls, 24 built-in tools, and team collaboration, check out the full [AskAlf platform](https://askalf.org).

## License

MIT
