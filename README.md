# zenmarked

A standalone markdown editor with live preview, CodeMirror syntax highlighting,
and drag-and-drop image support. Runs as a local web server in your browser.

## Usage

```
uv run zenmarked.py [FILE.md] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `FILE.md` | Optional. File to open on start (created if it doesn't exist). Its directory becomes the working directory. |

### Options

| Option | Description |
|--------|-------------|
| `--port PORT` | Port to listen on (default: 5055) |
| `--image-dir PATH` | Directory for uploaded images (default: `images/` inside working dir) |
| `--no-autosave` | Disable auto-save (use Ctrl+S only) |
| `--theme THEME` | Color theme: `light` or `dark` (default: `dark`) |
| `--no-browser` | Don't auto-open browser on start |

### Examples

```bash
# Open CWD — sidebar shows all .md files, create/edit freely
uv run zenmarked

# Open a specific file
uv run zenmarked notes.md

# Light theme, custom port
uv run zenmarked journal.md --theme light --port 8080

# Custom image directory, no autosave
uv run zenmarked docs/readme.md --image-dir docs/assets/imgs --no-autosave
```

## Features

- **3-column layout**: sidebar (file list + image gallery) + editor + live preview
- **CodeMirror** editor with markdown syntax highlighting
- **Live preview** via marked.js, updates as you type
- **Auto-save** (1s debounce after typing), togglable
- **Ctrl+S** to save manually at any time
- **Image upload**: drag-and-drop, click drop zone, or paste from clipboard
- **Image insertion modal**: alt text, caption, alignment, custom width
- **Click image in preview** to edit its properties
- **Rename image** with automatic reference update across all `.md` files in working dir
- **Smart URL paste**: select text in editor, paste a URL → auto-creates a markdown link
- **Light / Dark themes**

## Requirements

Managed with [uv](https://docs.astral.sh/uv/). Dependencies (`flask`, `pillow`) are declared in `pyproject.toml` and installed automatically on first run.

## Image paths

Images are stored in `./images/` (relative to the working directory) by default,
and inserted into markdown as `./images/filename.png`. The preview panel
substitutes these with `/static/images/` for serving.

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save current file |
| `Alt+N` | Create new file |
| `Escape` | Close modals |
