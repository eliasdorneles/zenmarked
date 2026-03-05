#!/usr/bin/env python3
"""
zenmarked — Standalone Markdown Editor

A local markdown editor with drag-and-drop images, live preview, and auto-save.
Usage: python zenmarked.py [FILE.md] [--port PORT] [--image-dir PATH] [--no-autosave] [--theme THEME] [--no-browser]
"""

import argparse
import io
import os
import re
import sys
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory
from PIL import Image

# ── CLI args ────────────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        prog="zenmarked",
        description="Standalone markdown editor with live preview and image support",
    )
    parser.add_argument(
        "file",
        nargs="?",
        metavar="FILE.md",
        help="Markdown file to open (created if it doesn't exist). "
             "Its directory becomes the working directory.",
    )
    parser.add_argument("--port", type=int, default=5055, help="Port to listen on (default: 5055)")
    parser.add_argument(
        "--image-dir",
        metavar="PATH",
        help="Directory for uploaded images (default: images/ inside working dir)",
    )
    parser.add_argument("--no-autosave", action="store_true", help="Disable auto-save (Ctrl+S only)")
    parser.add_argument("--theme", choices=["light", "dark"], default=None, help="Color theme (default: light)")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open browser on start")
    return parser.parse_args()


args = parse_args()

# ── Resolve paths ────────────────────────────────────────────────────────────

EDITOR_DIR = Path(__file__).resolve().parent

if args.file:
    target = Path(args.file).resolve()
    WORKING_DIR = target.parent
    INITIAL_FILE = target.name
    # Create file if it doesn't exist
    if not target.exists():
        WORKING_DIR.mkdir(parents=True, exist_ok=True)
        target.write_text("", encoding="utf-8")
        print(f"Created new file: {target}")
else:
    WORKING_DIR = Path.cwd()
    INITIAL_FILE = None

if args.image_dir:
    IMAGE_DIR = Path(args.image_dir).resolve()
else:
    IMAGE_DIR = WORKING_DIR / "images"

IMAGE_DIR.mkdir(parents=True, exist_ok=True)

# Relative name of image dir as seen from working dir (used in markdown paths)
try:
    IMAGE_DIR_REL = IMAGE_DIR.relative_to(WORKING_DIR)
except ValueError:
    IMAGE_DIR_REL = Path(IMAGE_DIR.name)

AUTOSAVE_ENABLED = not args.no_autosave
THEME = args.theme or "light"
THEME_EXPLICIT = args.theme is not None
PORT = args.port

print(f"Working directory: {WORKING_DIR}")
print(f"Images directory: {IMAGE_DIR}")
print(f"Initial file: {INITIAL_FILE or '(none)'}")

# ── Constants ────────────────────────────────────────────────────────────────

ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "svg"}
MAX_IMAGE_WIDTH = 1200
JPEG_QUALITY = 85
PNG_COMPRESS_LEVEL = 6

app = Flask(__name__)


# ── Helpers ──────────────────────────────────────────────────────────────────

def sanitize_filename(filename: str) -> str:
    filename = os.path.basename(filename)
    filename = filename.replace(" ", "_")
    filename = re.sub(r"[^\w\-.]", "", filename)
    return filename


def allowed_file(filename: str) -> bool:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in ALLOWED_IMAGE_EXTENSIONS


def process_image(file_data: bytes, filename: str) -> tuple[bytes, str]:
    """
    Resize if too large, compress. Returns (processed_bytes, final_filename).
    SVGs and GIFs are passed through untouched.
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext in ("svg", "gif"):
        return file_data, filename

    try:
        img = Image.open(io.BytesIO(file_data))

        if ext in ("jpg", "jpeg") and img.mode == "RGBA":
            background = Image.new("RGB", img.size, (255, 255, 255))
            background.paste(img, mask=img.split()[3])
            img = background

        if img.width > MAX_IMAGE_WIDTH:
            ratio = MAX_IMAGE_WIDTH / img.width
            new_height = int(img.height * ratio)
            img = img.resize((MAX_IMAGE_WIDTH, new_height), Image.Resampling.LANCZOS)
            print(f"Resized image to {MAX_IMAGE_WIDTH}x{new_height}")

        output = io.BytesIO()
        if ext in ("jpg", "jpeg"):
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.save(output, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        elif ext == "png":
            img.save(output, format="PNG", optimize=True, compress_level=PNG_COMPRESS_LEVEL)
        elif ext == "webp":
            img.save(output, format="WEBP", quality=JPEG_QUALITY, optimize=True)
        else:
            return file_data, filename

        processed_data = output.getvalue()
        if len(processed_data) < len(file_data):
            print(f"Compressed: {len(file_data)} → {len(processed_data)} bytes ({100 * len(processed_data) // len(file_data)}%)")
            return processed_data, filename
        else:
            return file_data, filename

    except Exception as e:
        print(f"Error processing image: {e}")
        return file_data, filename


def safe_file_path(filename: str) -> Path | None:
    """Return absolute path only if it resolves inside WORKING_DIR."""
    path = (WORKING_DIR / filename).resolve()
    if path.parent == WORKING_DIR and path.suffix == ".md":
        return path
    return None


def image_markdown_prefix() -> str:
    """Return the markdown path prefix for images, e.g. './images/'"""
    return f"./{IMAGE_DIR_REL}/"


def find_files_with_image(filename: str) -> list[dict]:
    """Find all .md files in WORKING_DIR that reference the given image filename."""
    prefix = image_markdown_prefix()
    pattern = re.compile(re.escape(f"{prefix}{filename}"))
    refs = []
    for filepath in WORKING_DIR.glob("*.md"):
        try:
            content = filepath.read_text(encoding="utf-8")
            matches = pattern.findall(content)
            if matches:
                refs.append({
                    "filename": filepath.name,
                    "title": filepath.stem,
                    "ref_count": len(matches),
                })
        except Exception as e:
            print(f"Error reading {filepath}: {e}")
    return refs


def update_image_references(content: str, old_filename: str, new_filename: str) -> str:
    prefix = image_markdown_prefix()
    return content.replace(f"{prefix}{old_filename}", f"{prefix}{new_filename}")


# ── Routes ───────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_file(EDITOR_DIR / "editor.html")


@app.route("/api/config")
def get_config():
    return jsonify({
        "autosave": AUTOSAVE_ENABLED,
        "theme": THEME,
        "themeExplicit": THEME_EXPLICIT,
        "initialFile": INITIAL_FILE,
        "workingDir": str(WORKING_DIR),
        "imagePrefix": image_markdown_prefix(),
    })


@app.route("/api/files", methods=["GET"])
def list_files():
    files = []
    for filepath in sorted(WORKING_DIR.glob("*.md"), key=lambda p: p.name):
        files.append({
            "filename": filepath.name,
            "modified": filepath.stat().st_mtime,
        })
    return jsonify(files)


@app.route("/api/files", methods=["POST"])
def create_file():
    data = request.get_json()
    filename = data.get("filename", "").strip()
    if not filename:
        return jsonify({"error": "Filename is required"}), 400

    # Ensure .md extension
    if not filename.endswith(".md"):
        filename += ".md"

    filename = sanitize_filename(filename)
    if not filename or filename == ".md":
        return jsonify({"error": "Invalid filename"}), 400

    filepath = WORKING_DIR / filename
    if filepath.exists():
        return jsonify({"error": f"File '{filename}' already exists"}), 400

    filepath.write_text("", encoding="utf-8")
    return jsonify({"success": True, "filename": filename})


@app.route("/api/files/<filename>", methods=["GET"])
def get_file(filename: str):
    filepath = safe_file_path(filename)
    if not filepath or not filepath.exists():
        return jsonify({"error": "File not found"}), 404

    content = filepath.read_text(encoding="utf-8")
    return jsonify({"filename": filename, "content": content})


@app.route("/api/files/<filename>", methods=["PUT"])
def save_file(filename: str):
    filepath = safe_file_path(filename)
    if not filepath:
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_json()
    if data is None:
        return jsonify({"error": "No data provided"}), 400

    content = data.get("content", "")
    filepath.write_text(content, encoding="utf-8")
    return jsonify({"success": True, "filename": filename})


@app.route("/api/files/<filename>", methods=["DELETE"])
def delete_file(filename: str):
    filepath = safe_file_path(filename)
    if not filepath or not filepath.exists():
        return jsonify({"error": "File not found"}), 404

    filepath.unlink()
    return jsonify({"success": True, "filename": filename})


@app.route("/api/images", methods=["GET"])
def list_images():
    images = []
    for ext in ALLOWED_IMAGE_EXTENSIONS:
        for filepath in IMAGE_DIR.glob(f"*.{ext}"):
            images.append({"filename": filepath.name, "url": f"/static/images/{filepath.name}"})
        for filepath in IMAGE_DIR.glob(f"*.{ext.upper()}"):
            images.append({"filename": filepath.name, "url": f"/static/images/{filepath.name}"})

    images.sort(key=lambda x: (IMAGE_DIR / x["filename"]).stat().st_mtime, reverse=True)
    return jsonify(images[:20])


@app.route("/api/images", methods=["POST"])
def upload_image():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "No filename"}), 400

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        return jsonify({"error": f"Invalid file type. Allowed: {', '.join(sorted(ALLOWED_IMAGE_EXTENSIONS))}"}), 400

    filename = sanitize_filename(file.filename)
    file_data = file.read()
    processed_data, filename = process_image(file_data, filename)

    filepath = IMAGE_DIR / filename
    counter = 1
    base, ext_with_dot = os.path.splitext(filename)
    while filepath.exists():
        filename = f"{base}_{counter}{ext_with_dot}"
        filepath = IMAGE_DIR / filename
        counter += 1

    filepath.write_bytes(processed_data)
    return jsonify({"success": True, "filename": filename, "url": f"/static/images/{filename}"})


@app.route("/api/images/<path:filename>/references", methods=["GET"])
def get_image_references(filename: str):
    filepath = IMAGE_DIR / filename
    if not filepath.exists():
        return jsonify({"error": "Image not found"}), 404

    files = find_files_with_image(filename)
    return jsonify({
        "filename": filename,
        "files": files,
        "total_refs": sum(f["ref_count"] for f in files),
    })


@app.route("/api/images/<path:filename>/rename", methods=["POST"])
def rename_image(filename: str):
    filepath = IMAGE_DIR / filename
    if not filepath.exists():
        return jsonify({"error": "Image not found"}), 404

    data = request.get_json()
    if not data or not data.get("new_name"):
        return jsonify({"error": "New name is required"}), 400

    new_name_base = sanitize_filename(data["new_name"].strip())
    if not new_name_base:
        return jsonify({"error": "Invalid filename after sanitization"}), 400

    _, ext = os.path.splitext(filename)
    new_filename = new_name_base + ext

    if new_filename == filename:
        return jsonify({"error": "New name is the same as current name"}), 400

    new_filepath = IMAGE_DIR / new_filename
    if new_filepath.exists():
        return jsonify({"error": f"An image named '{new_filename}' already exists"}), 400

    # Update references in all .md files
    files_updated = []
    for md_filepath in WORKING_DIR.glob("*.md"):
        try:
            content = md_filepath.read_text(encoding="utf-8")
            prefix = image_markdown_prefix()
            if f"{prefix}{filename}" in content:
                updated_content = update_image_references(content, filename, new_filename)
                md_filepath.write_text(updated_content, encoding="utf-8")
                files_updated.append({"filename": md_filepath.name, "title": md_filepath.stem})
        except Exception as e:
            print(f"Error updating {md_filepath}: {e}")

    # Rename the actual image
    try:
        filepath.rename(new_filepath)
    except Exception as e:
        # Rollback reference updates
        for info in files_updated:
            md_filepath = WORKING_DIR / info["filename"]
            try:
                content = md_filepath.read_text(encoding="utf-8")
                md_filepath.write_text(update_image_references(content, new_filename, filename), encoding="utf-8")
            except Exception:
                pass
        return jsonify({"error": f"Failed to rename file: {e}"}), 500

    return jsonify({
        "success": True,
        "old_filename": filename,
        "new_filename": new_filename,
        "updated_files": files_updated,
    })


@app.route("/static/images/<path:filename>")
def serve_image(filename: str):
    return send_from_directory(IMAGE_DIR, filename)


@app.route("/static/vendor/<path:filename>")
def serve_vendor(filename: str):
    return send_from_directory(EDITOR_DIR / "vendor", filename)


@app.route("/static/editor.css")
def serve_editor_css():
    return send_file(EDITOR_DIR / "editor.css", mimetype="text/css")


@app.route("/static/editor.js")
def serve_editor_js():
    return send_file(EDITOR_DIR / "editor.js", mimetype="application/javascript")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    url = f"http://127.0.0.1:{PORT}"
    print(f"Starting zenmarked at {url}")

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    app.run(host="127.0.0.1", port=PORT, debug=False)


if __name__ == "__main__":
    main()
