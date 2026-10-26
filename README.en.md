# JSON Beautifier & Viewer (Firefox Style) — Chrome Extension

English | [简体中文](README.md)

Replaces Chrome's built-in JSON view (the "Pretty print" page) with a Firefox-style tree view:
**collapsible, syntax-highlighted, searchable, with path display and one-click copy**. It kicks in
automatically on any `application/json` page.

![Screenshot](test/shots/1-sample-tree.png)

## Features

- **Automatic takeover**: pages served as `application/json` (including `*+json`) are rendered as a
  collapsible tree, replacing Chrome's built-in "Pretty print"; plain-text JSON pages (`text/plain`)
  are taken over too (when the page is essentially a single text block).
- **Collapsing**: click a row or the arrow to expand/collapse; collapsed nodes show a summary like
  `{ … 11 keys }` or `[ … 20000 items ]`; toolbar buttons "Expand all / Collapse all".
- **Color coding**: keys=purple, strings=green, numbers=blue, booleans=red, null=gray, array
  indices=light gray; automatically follows the system dark mode.
- **Search**: case-insensitive matching on keys and values; hits are highlighted and their paths
  auto-expanded, with an "N matches" counter; Esc clears.
- **Path bar**: click any key or value and the status bar shows its JSONPath-style path
  (e.g. `$.data[0].config.timeout`), one click to copy.
- **Copy**: double-click a value to copy it; "Copy JSON" copies the whole formatted document.
- **Raw view**: switch between the tree and the raw text at any time.
- **Large files**: the default expand depth adapts to a node budget, with a 60k-node render cap
  (the status bar warns when the cap is hit; the page never freezes).
- **Manual fallback**: click the toolbar icon to force-beautify the current page (e.g. APIs that
  return JSON as `text/html`); when already beautified, clicking toggles tree/raw view.

## Installation (Load unpacked)

1. Open `chrome://extensions` in Chrome;
2. Turn on **Developer mode** (top right);
3. Click **Load unpacked** (top left) and pick this directory (`chrome-json-viewer`);
4. Open any JSON endpoint (e.g. `https://api.example.com/xxx.json`) to see the new view.

> Tip: to view local `.json` files (`file://`), enable "Allow access to file URLs" for this
> extension on `chrome://extensions`.

## Testing

The repository ships a local test server and an end-to-end script:

```bash
node test/server.js   # local test server at http://127.0.0.1:18080
node test/e2e.js      # requires Node 22+; launches headless Chrome, loads the extension and verifies it
```

Test pages (visit with the extension installed):

| Page | Expected |
| --- | --- |
| `/sample.json` (application/json) | auto takeover, tree view |
| `/sample.txt` (text/plain) | auto takeover |
| `/notjson.txt` | untouched |
| `/big.json` (3.67 MB / 20k items) | browsable in ~3 s, expansion protected by budget |
| `/harness.html#__jv_force` | debug the renderer without installing the extension |

Verified end to end: auto takeover, Chrome's built-in `<pre>` replaced, collapse/expand, search
highlight & counter, path display, raw view toggle, text/plain fallback, non-JSON pages untouched,
dark mode.

## Directory layout

```
chrome-json-viewer/
├── manifest.json        # MV3 manifest (content_scripts + action + scripting)
├── background.js        # toolbar icon click → force beautify / toggle view
├── src/
│   ├── viewer.js        # tree renderer (collapse/highlight/search/path; plain DOM, no deps)
│   ├── content.js       # detects JSON pages and takes over
│   ├── manual.js        # manual trigger entry
│   └── viewer.css       # styles (light/dark, all scoped inside #jv-root)
├── icons/               # 16/32/48/128 icons
├── tools/make-icons.js  # icon generator (plain Node, no deps)
└── test/                # local server, fixtures, CDP e2e script, screenshots
```

## How it works

For a top-level document with `Content-Type: application/json`, Chrome renders
`<body><pre>JSON text</pre></body>`. This extension's content script checks `document.contentType`,
grabs the `<pre>` text, and on a successful `JSON.parse` clears the page and mounts its own tree
view (lazy rendering: children of collapsed containers are never built). Non-JSON pages are left
untouched.

## Known limitations

- JSON delivered as a download (`Content-Disposition: attachment`) never renders as a page, so it
  cannot be taken over;
- duplicate keys follow `JSON.parse` semantics (last one wins);
- "Expand all" beyond 60k nodes truncates with a status-bar notice; everything else keeps working.
