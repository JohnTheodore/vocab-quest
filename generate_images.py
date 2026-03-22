#!/usr/bin/env python3
"""
Vocabulary Quest — Image Generator
Generates storybook illustrations for vocabulary words using the Gemini API,
then packages them into a .tar.gz bundle for upload to the vocab game.

Usage:
    python generate_images.py --key YOUR_GEMINI_API_KEY --input words.json --output vocab-images.tar.gz
"""

import argparse
import base64
import json
import os
import sys
import tarfile
import tempfile
import time
from io import BytesIO
from pathlib import Path

# ── Argument parsing ──────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Generate vocab game illustrations via Gemini")
parser.add_argument("--key",    required=True,  help="Gemini API key (from aistudio.google.com)")
parser.add_argument("--input",  required=True,  help="Path to words.json exported from the vocab game")
parser.add_argument("--output", default="vocab-images.tar.gz", help="Output tarball path")
parser.add_argument("--model",  default="gemini-2.5-flash-image",
                    choices=[
                        "gemini-2.5-flash-image",
                        "gemini-3.1-flash-image-preview",
                        "gemini-3-pro-image-preview",
                    ],
                    help="Gemini image model to use")
parser.add_argument("--delay",  type=float, default=2.0,
                    help="Seconds to wait between API calls (avoid rate limiting)")
args = parser.parse_args()

# ── Load words ────────────────────────────────────────────────────────────────
try:
    with open(args.input) as f:
        words = json.load(f)
    if not isinstance(words, list) or not words:
        print("ERROR: words.json must be a non-empty JSON array")
        sys.exit(1)
    print(f"Loaded {len(words)} words from {args.input}")
except FileNotFoundError:
    print(f"ERROR: File not found: {args.input}")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"ERROR: Invalid JSON in {args.input}: {e}")
    sys.exit(1)

# ── Import dependencies ───────────────────────────────────────────────────────
try:
    from google import genai
    from google.genai import types
except ImportError:
    print("ERROR: google-genai not installed.")
    print("Rebuild the Docker image: docker build --no-cache -t vocab-image-gen .")
    sys.exit(1)

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    print("WARNING: Pillow not installed — images won't be resized.")
    HAS_PIL = False

# ── Configure client ──────────────────────────────────────────────────────────
client = genai.Client(api_key=args.key)
print(f"Using model: {args.model}")

# ── Generate images ───────────────────────────────────────────────────────────
results = []
failed = []

with tempfile.TemporaryDirectory() as tmpdir:
    for i, entry in enumerate(words):
        word = entry.get("word", f"word_{i}")
        base_prompt = entry.get("imagePrompt", f"A storybook illustration representing the word '{word}'")
        style = "Painterly Victorian storybook illustration, warm amber and cool grey palette, soft chiaroscuro lighting, oil paint texture, no text in image"
        prompt = f"{base_prompt}. {style}"
        filename = f"{word.lower().replace(' ', '_')}.jpg"
        filepath = os.path.join(tmpdir, filename)

        print(f"\n[{i+1}/{len(words)}] Generating: {word}")
        print(f"  Prompt: {base_prompt[:80]}... [+ style]")

        success = False
        for attempt in range(3):
            try:
                response = client.models.generate_content(
                    model=args.model,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_modalities=["IMAGE"],
                    ),
                )

                # Extract image from response parts
                img_bytes = None
                for part in response.candidates[0].content.parts:
                    if part.inline_data is not None:
                        raw = part.inline_data.data
                        img_bytes = base64.b64decode(raw) if isinstance(raw, str) else bytes(raw)
                        break

                if not img_bytes:
                    print(f"  WARNING: No image in response (attempt {attempt+1})")
                    if attempt < 2:
                        time.sleep(args.delay * 2)
                    continue

                if HAS_PIL:
                    img = Image.open(BytesIO(img_bytes))
                    if img.width > 900:
                        ratio = 900 / img.width
                        img = img.resize((900, int(img.height * ratio)), Image.LANCZOS)
                    if img.mode in ("RGBA", "P", "LA"):
                        img = img.convert("RGB")
                    img.save(filepath, "JPEG", quality=85)
                    print(f"  ✓ {filename} ({img.width}x{img.height})")
                else:
                    with open(filepath, "wb") as f:
                        f.write(img_bytes)
                    print(f"  ✓ {filename}")

                results.append({"word": word, "filename": filename})
                success = True
                break

            except Exception as e:
                print(f"  ERROR (attempt {attempt+1}): {e}")
                if attempt < 2:
                    time.sleep(args.delay * 3)

        if not success:
            print(f"  FAILED: {word}")
            failed.append(word)

        if i < len(words) - 1:
            time.sleep(args.delay)

    if not results:
        print("\nERROR: No images generated. Rebuild Docker image:")
        print("  docker build --no-cache -t vocab-image-gen .")
        sys.exit(1)

    # ── Write manifest ────────────────────────────────────────────────────────
    manifest_path = os.path.join(tmpdir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump({
            "version": 1,
            "model": args.model,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "images": results,
        }, f, indent=2)

    # ── Pack tarball ──────────────────────────────────────────────────────────
    output_path = Path(args.output)
    with tarfile.open(output_path, "w:gz") as tar:
        tar.add(manifest_path, arcname="manifest.json")
        for entry in results:
            tar.add(os.path.join(tmpdir, entry["filename"]), arcname=entry["filename"])

    size_kb = output_path.stat().st_size / 1024
    print(f"\n✓ {output_path} ({size_kb:.0f} KB) — {len(results)} images")
    if failed:
        print(f"  Failed: {', '.join(failed)}")

print("\nDone! Upload vocab-images.tar.gz to the vocab game.")
