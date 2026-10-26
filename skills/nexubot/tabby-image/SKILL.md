---
name: tabby-image
catalog-name: Tabby Image (Official)
description: Generate images through the Tabby relay with the tabby-image model enabled for the logged-in Tabby account. Triggers on "generate image", "tabby image", "official image model", "gpt image".
metadata:
  openclaw:
    emoji: "🖼️"
---

# Tabby Image

Generates images with the `tabby-image` model enabled for the logged-in Tabby cloud account. No API key configuration is required; the skill reads the existing account credential and relay URL automatically.

`tabby-image` uses the GPT-image-2 request format and supports quality and transparent-background controls. It is the only model, so `--model` can be omitted; the older ids `tabby-image-pro`, `tabby-image-flash` and `tabby-image-free` are accepted and resolve to `tabby-image`.

## Generate an image

```bash
node {baseDir}/scripts/generate-image.js --prompt "a cat sitting on mars" --filename "cat-on-mars.png"
```

With size and quality controls:

```bash
node {baseDir}/scripts/generate-image.js --prompt "a transparent glass teapot" --filename "teapot.png" --ratio 16:9 --quality high --transparent-background
```

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--prompt` | `-p` | required | Image description |
| `--filename` | `-f` | required | Output filename |
| `--model` | - | `tabby-image` | `tabby-image` |
| `--size` | - | model default | `auto`, `1K`, `2K`, `3K`, `4K`, or an exact supported `WIDTHxHEIGHT` |
| `--ratio` | - | `1:1` orientation | `1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `2:3`, `3:2`, or `21:9` |
| `--quality` | - | model default | `auto`, `high`, `medium`, or `low` |
| `--transparent-background` | - | off | Request a transparent background |

`--ratio` selects a matching GPT-image-2 size when `--size` is omitted or uses a resolution tier. Exact dimensions must be divisible by 16, stay between 1:3 and 3:1, and fit within the model limits.

## Account requirements

This skill uses the Tabby cloud credential and relay URL already configured on this machine. If the script errors with "not logged in", tell the user to log into their Tabby account in the desktop app (Settings) and try again. If it reports that the account does not have access to `tabby-image`, tell the user to check the account entitlement.

## Output

Relative filenames are saved to `$OPENCLAW_STATE_DIR/media/outbound/{slugid}/tabby-image/{filename}`. Absolute paths are used as-is. Use timestamps in filenames to avoid overwrites: `cat-on-mars-20260304-165000.png`.

## Sending images to the user

The script prints a `MEDIA: <absolute-path>` line on stdout. **You MUST include this exact MEDIA: line in your reply text** so the image is delivered as an attachment in chat.

Example reply:
```
Here's your image!
MEDIA: /Users/alche/.openclaw/media/outbound/my-bot/tabby-image/cat-on-mars.png
```

Rules:
- Copy the `MEDIA:` line from the script output into your reply verbatim — this is how images get sent
- Do NOT read the generated image back with the read tool
- Do NOT try to base64 encode or manually attach the image
- The `MEDIA:` line must be on its own line in your response

## Scope

This skill only generates new images from a text prompt. It does not support editing an existing image or combining multiple images — use a different image skill for those if one is installed.
