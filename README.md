# Browser Control Lab

Browser Control Lab is a local experiment for controlling a user's existing Chrome browser from an agent-friendly CLI.

The goal is different from launching a disposable browser profile: this project keeps the user's real Chrome login state, cookies, extensions, and platform context, then exposes a small command layer for opening pages, inspecting accessibility snapshots, clicking, filling forms, uploading files, taking screenshots, and closing temporary tabs.

## Why this exists

Agent Browser and Playwright are excellent for isolated testing. Browser MCP is useful for connecting a real tab through MCP. This project explores a third shape:

- keep the real Chrome profile
- run a tiny local HTTP agent on `127.0.0.1`
- let a Chrome extension background operator poll that local agent
- send browser commands through a CLI that feels familiar to AI coding agents
- group task pages in Chrome tab groups
- avoid foreground interruption by default

## Project status

This is a lab project, not a polished package. It currently targets macOS and Google Chrome.

The main route is:

```text
scripts/my-browser
  -> local-agent.mjs on 127.0.0.1:17654
  -> Chrome extension background service worker
  -> chrome.debugger / tabs / tabGroups
  -> existing Chrome tabs
```

## Quick start

Clone the repository and run the CLI directly:

```bash
git clone https://github.com/oil-oil/my-browser.git
cd my-browser
./scripts/my-browser ensure
./scripts/my-browser doctor
```

Load the Chrome extension:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose "Load unpacked".
4. Select `local-browser-operator-extension` from this repository.
5. Run `./scripts/my-browser doctor` again.

You can also print recovery instructions:

```bash
./scripts/my-browser install-help
```

By default, `install-help` only prints instructions. It does not open Chrome or change the clipboard unless explicit flags are passed.

## Common commands

```bash
./scripts/my-browser ensure
./scripts/my-browser doctor
./scripts/my-browser open https://example.com --group-name "Research"
./scripts/my-browser snapshot <tabId> -n 30
./scripts/my-browser summary <tabId> --limit 800
./scripts/my-browser fields <tabId> title="h1"
./scripts/my-browser click @e2
./scripts/my-browser fill @e1 "hello"
./scripts/my-browser upload "input[type=file]" "/absolute/path/to/file.mp4"
./scripts/my-browser screenshot --annotate /tmp/my-browser.png <tabId>
./scripts/my-browser close <tabId>
./scripts/my-browser detach
```

The CLI supports:

- listing Chrome tabs
- opening pages in task-specific tab groups
- accessibility-tree snapshots with `@e1` style refs
- scoped snapshots and low-token summaries
- field extraction and text lookup
- click, double click, hover, focus, fill, type, keyboard input, check, uncheck, select, and scroll
- local file upload into `input[type=file]`
- screenshots with optional ref annotations
- console, page error, network request, and diagnostics inspection
- confirmation gates for high-impact actions such as publish, payment, delete, or final submit buttons

## Tab cleanup

`detach` only releases the debugging connection. It does not close tabs.

Agents using this tool should track tabs opened for the current task and close temporary research, search, screenshot, failed, blank, or duplicate tabs before calling `detach`.

Keep tabs when they contain an unfinished upload, publishing progress, login or QR verification, unsaved draft, user-visible preview, or a page the user explicitly asked to keep open.

## Safety model

This project intentionally uses a local-only bridge:

- local agent listens on `127.0.0.1:17654`
- extension host permission is limited to `http://127.0.0.1:17654/*`
- Chrome extension installation and permission changes require user approval
- high-impact browser actions should go through confirmation

Do not use this tool to bypass browser security prompts, platform rules, payment confirmations, or user consent.

## Browser notes

Chrome's remote debugging behavior has changed in recent versions. Attaching CDP to the default data directory is no longer a reliable route for controlling a user's everyday Chrome profile. That is one reason this project uses a Chrome extension plus a local agent instead of trying to attach directly to the main Chrome instance through a debug port.

## Repository layout

```text
local-agent.mjs                         local command queue server
scripts/my-browser                      agent-friendly CLI entry
src/cli/main.mjs                        CLI implementation
local-browser-operator-extension/       Chrome extension background operator
test-pages/                             local HTML fixtures
docs/                                   GitHub Pages demo site
references/                            design notes and prior art
```

## Development

Run syntax checks:

```bash
node --check local-agent.mjs
node --check src/cli/main.mjs
node --check local-browser-operator-extension/background.js
```

Run the local agent manually:

```bash
node local-agent.mjs
```

## License

MIT
