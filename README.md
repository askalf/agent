# @askalf/agent

**Your Claude subscription now controls your entire computer.**

One npm install. Uses your existing Claude Pro/Max subscription — zero extra API costs. PowerShell-first. Interactive sessions. Full computer control.

## Install

```bash
npm i -g @askalf/agent
```

Requires Node.js 20+ and [Claude CLI](https://docs.anthropic.com/en/docs/claude-code).

## Quick Start

```bash
# 1. Install Claude CLI (if you don't have it)
npm i -g @anthropic-ai/claude-code
claude auth login

# 2. Authenticate
askalf-agent auth
# Select "Claude Login" (recommended)

# 3. Run
askalf-agent run "open notepad and type hello world"
```

That's it. Claude opens Notepad, types "Hello World", then asks **"What next?"** — a persistent interactive session.

## How It Works

```
$ askalf-agent run "open chrome and go to amazon.com"

✔ AskAlf Agent — Computer Control
ℹ Using Claude subscription (no per-token costs)
ℹ Type "exit" or Ctrl+C to quit

ℹ → open chrome and go to amazon.com

✔ Chrome is open with Amazon loaded.
ℹ (6 turns)

❯ What next? open notepad and type hello world

✔ Notepad now has "Hello World" in it.
ℹ (14 turns)

❯ What next? exit
ℹ Session ended.
```

**PowerShell-first** — Claude runs PowerShell commands directly to open apps, browse the web, manage files, and automate tasks. No slow screenshot loops. A screenshot MCP tool is available when Claude needs to visually verify what's on screen, but most tasks complete entirely through PowerShell.

## Authentication

### Claude Login (Recommended)

Uses your existing Claude Pro/Max subscription. **Zero extra API costs.** This is the default.

```bash
npm i -g @anthropic-ai/claude-code
claude auth login
askalf-agent auth
# Select "Claude Login"
```

### API Key (Fallback)

Paste your Anthropic API key. Pay per token. Uses the Anthropic SDK directly with the `computer_20251124` tool.

```bash
askalf-agent auth
# Select "API Key" → paste your sk-ant-... key
```

> **Note:** SDK mode uses computer-use API calls which cost per token. A simple task like "open notepad" can cost several dollars. Claude Login mode is strongly recommended.

## Commands

### `askalf-agent run "<prompt>"`

Start an interactive computer control session.

```bash
askalf-agent run "resize all images in ./assets to 800px wide"
askalf-agent run "open VS Code and create a Flask hello world app"
askalf-agent run "go to github.com and star the SprayberryLabs/agent repo"
```

Each task completes and prompts **"What next?"** for follow-up commands. Type `exit` or hit Ctrl+C to end the session.

Options:
- `-m, --model <model>` — Model to use (default: `claude-sonnet-4-6`)
- `-b, --budget <amount>` — Max budget in USD for SDK mode (default: `5.00`)
- `-t, --turns <count>` — Max turns per task (default: `50`)

### `askalf-agent auth`

Configure authentication interactively.

- `askalf-agent auth --status` — Show current auth status

### `askalf-agent check`

Verify platform dependencies are installed.

### `askalf-agent config`

View or update configuration.

```bash
askalf-agent config --model claude-opus-4-6 --turns 100
```

## What It Can Do

| Capability | How |
|---|---|
| **Open apps** | `Start-Process chrome`, `Start-Process notepad` |
| **Browse the web** | Opens Chrome, navigates sites, fills forms |
| **Manage files** | Create, move, read, edit files anywhere on your system |
| **Run commands** | Git, npm, Docker, Python — any CLI tool |
| **See your screen** | Screenshot tool for visual verification when needed |
| **Chain tasks** | Interactive loop — complete a task, ask "What next?" |

## Platform Support

| OS | Status | Computer Control |
|----|--------|-----------------|
| **Windows** | Full support | PowerShell (pre-installed) |
| **macOS** | Full support | `cliclick` (`brew install cliclick`) |
| **Linux (X11)** | Full support | `xdotool` + `scrot` (`apt install xdotool scrot`) |
| **Linux (Wayland)** | Full support | `ydotool` + `grim` (`apt install ydotool grim`) |

Run `askalf-agent check` to verify your setup.

## Architecture

```
askalf-agent run "open chrome"
        │
        ├── Claude Login (default)
        │       │
        │       ├── Spawns claude CLI
        │       ├── --append-system-prompt (computer control agent)
        │       ├── --mcp-config (screenshot tool)
        │       ├── Claude uses built-in bash → PowerShell
        │       └── Interactive loop: task → "What next?" → repeat
        │
        └── API Key (fallback)
                │
                ├── Anthropic SDK direct
                ├── computer_20251124 + bash + text_editor tools
                └── Single-run with cost summary
```

The MCP server exposes a single `screenshot` tool. All other computer control happens through Claude's built-in bash tool running PowerShell commands — this is dramatically faster than screenshot-based control loops.

## Configuration

Config stored at `~/.askalf/config.json`:

```json
{
  "authMode": "oauth",
  "model": "claude-sonnet-4-6",
  "maxBudgetUsd": 5.00,
  "maxTurns": 50
}
```

## Full Platform

This CLI is a standalone agent for individual use. For multi-agent orchestration, scheduling, cost controls, 24 built-in tools, and team collaboration, check out the full [AskAlf platform](https://askalf.org).

## Links

- [Try page](https://askalf.org/try)
- [npm package](https://www.npmjs.com/package/@askalf/agent)
- [@ask_alf on X](https://x.com/ask_alf)

## License

MIT
