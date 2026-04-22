# Pi Model Selector

A Pi coding agent extension that enhances model selection with pricing information.

## Features

- **`/models` command** — Lists all available models with pricing (input/output price per million tokens)
- **Smart sorting** — Sort by input price (`Shift+Ctrl+I`), output price (`Shift+Ctrl+O`), or filter by provider (`Shift+Ctrl+P`)
- **Provider display** — Clean provider names and enriched model metadata

## Installation

Place this file in your Pi extensions directory:

```bash
~/.pi/agent/extensions/pi-model-selector.ts
```

Pi will load it automatically.

## Usage

Once installed, use `/models` in any Pi session to browse available models with their pricing info.

## Tech Stack

- TypeScript
- Pi Extension API (`@mariozechner/pi-coding-agent`)
- Pi AI types (`@mariozechner/pi-ai`)
- Pi TUI components (`@mariozechner/pi-tui`)
