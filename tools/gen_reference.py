# -*- coding: utf-8 -*-
"""
Generate the reference fixtures used by the TypeScript parity test.

All code below is a faithful copy of:

  * split_sentences / hard_split / join_text_units / split_text
        -- from D:\\novel-tts-v1.0.0\\GUI_QWENv6.pyw
  * split_by_byte_length
        -- from rany2/edge-tts communicate.split_text_by_byte_length
           (this is what tts_backends.py exercises through edge-tts)
  * generate_sec_ms_gec
        -- from rany2/edge-tts drm.DRM.generate_sec_ms_gec

The file is deliberately ASCII-only: Windows Python may read/write .py
files using the system locale code page, and non-ASCII source text gets
mangled that way (which silently broke an earlier revision).

Usage:
    python tools/gen_reference.py build/python-reference.json
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape


DEFAULT_MAX_CHARS = 500
DEFAULT_MIN_CHARS = 480


# ----------------------------------------------------------------------
# Copied verbatim from GUI_QWENv6.pyw
# ----------------------------------------------------------------------

def split_sentences(text: str) -> list[str]:
    result: list[str] = []
    start = 0

    closing_chars = set("\u201d\u2019\u300d\u300f\u3011\u300b\uff09\uff09)]")

    for i, ch in enumerate(text):
        if i < start:
            continue

        if ch not in "\u3002\uff01\uff1f!?\uff1b;\u2026":
            continue

        end = i + 1

        while end < len(text) and text[end] in closing_chars:
            end += 1

        piece = text[start:end].strip()

        if piece:
            result.append(piece)

        start = end

    tail = text[start:].strip()

    if tail:
        result.append(tail)

    return result


def hard_split(text: str, max_chars: int) -> list[str]:
    result: list[str] = []
    text = text.strip()

    while len(text) > max_chars:
        cut_candidates = [
            text.rfind("\uff0c", 0, max_chars),
            text.rfind("\u3001", 0, max_chars),
            text.rfind(",", 0, max_chars),
            text.rfind("\uff1a", 0, max_chars),
            text.rfind(":", 0, max_chars),
            text.rfind(" ", 0, max_chars),
        ]

        cut = max(cut_candidates)

        if cut < int(max_chars * 0.4):
            cut = max_chars - 1

        piece = text[: cut + 1].strip()

        if piece:
            result.append(piece)

        text = text[cut + 1:].strip()

    if text:
        result.append(text)

    return result


def join_text_units(left: str, right: str) -> str:
    left = left or ""
    right = right or ""

    if not left:
        return right

    if not right:
        return left

    if left[-1].isspace() or right[0].isspace():
        return left + right

    if left[-1].isascii() and right[0].isascii():
        return left + " " + right

    return left + right


def split_text(
    text: str,
    max_chars: int = DEFAULT_MAX_CHARS,
    min_chars: int = DEFAULT_MIN_CHARS,
) -> list[str]:
    text = text.replace("\r\n", "\n")
    text = text.replace("\r", "\n")
    text = text.strip()

    if not text:
        return []

    max_chars = max(60, min(500, int(max_chars)))
    min_chars = max(0, min(int(min_chars), max_chars))

    paragraphs = re.split(r"\n\s*\n+", text)

    all_units: list[str] = []

    for paragraph in paragraphs:
        paragraph = re.sub(r"[ \t]*\n[ \t]*", "", paragraph).strip()

        if not paragraph:
            continue

        sentence_units = split_sentences(paragraph)

        if not sentence_units:
            sentence_units = [paragraph]

        normalized_units: list[str] = []

        for unit in sentence_units:
            unit = unit.strip()

            if not unit:
                continue

            if len(unit) <= max_chars:
                normalized_units.append(unit)
            else:
                normalized_units.extend(hard_split(unit, max_chars))

        all_units.extend(normalized_units)

    if not all_units:
        return []

    all_chunks: list[str] = []
    buffer = ""

    for unit in all_units:
        if not unit:
            continue

        if not buffer:
            buffer = unit
            continue

        if min_chars > 0 and len(buffer) < min_chars:
            buffer = join_text_units(buffer, unit)
            continue

        candidate = join_text_units(buffer, unit)

        if len(candidate) <= max_chars:
            buffer = candidate
        else:
            all_chunks.append(buffer.strip())
            buffer = unit

    if buffer:
        buffer = buffer.strip()

        if min_chars > 0 and len(buffer) < min_chars and all_chunks:
            all_chunks[-1] = join_text_units(all_chunks[-1], buffer).strip()
        else:
            all_chunks.append(buffer)

    return [chunk for chunk in all_chunks if chunk.strip()]


# ----------------------------------------------------------------------
# Copied from rany2/edge-tts: communicate.split_text_by_byte_length
# ----------------------------------------------------------------------

def split_by_byte_length_python(text: str, byte_length: int) -> list[str]:
    data = text.encode("utf-8")
    chunks: list[str] = []

    while len(data) > byte_length:
        # Upstream calls text.rfind, i.e. it searches only the first
        # byte_length bytes for a natural break.
        window = data[:byte_length]

        split_at = window.rfind(b"\n")

        if split_at < 0:
            split_at = window.rfind(b" ")

        if split_at < 0:
            # Upstream falls back to _find_safe_utf8_split_point, which walks
            # backwards from len(data) -- NOT from byte_length. On text with no
            # natural break this therefore returns the whole buffer, producing
            # one oversized chunk. We reproduce that behaviour here so the
            # comparison is meaningful; the TypeScript port deliberately caps
            # every chunk at byte_length instead.
            split_at = len(data)
            while split_at > 0:
                try:
                    data[:split_at].decode("utf-8")
                    break
                except UnicodeDecodeError:
                    split_at -= 1

        # Never cut an XML entity such as &amp; in half.
        while split_at > 0 and b"&" in data[:split_at]:
            amp = data.rindex(b"&", 0, split_at)
            if data.find(b";", amp, split_at) != -1:
                break
            split_at = amp

        chunk = data[:split_at].strip()

        if chunk:
            chunks.append(chunk.decode("utf-8"))

        data = data[split_at if split_at > 0 else 1:]

    remaining = data.strip()

    if remaining:
        chunks.append(remaining.decode("utf-8"))

    return chunks


# ----------------------------------------------------------------------
# Copied from rany2/edge-tts: drm.DRM.generate_sec_ms_gec
# ----------------------------------------------------------------------

WIN_EPOCH = 11644473600
TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"


def sec_ms_gec(now_ms: int) -> str:
    seconds = now_ms // 1000
    ticks = seconds + WIN_EPOCH
    ticks -= ticks % 300
    ticks *= 10**7

    return (
        hashlib.sha256(f"{ticks:.0f}{TRUSTED_CLIENT_TOKEN}".encode("ascii"))
        .hexdigest()
        .upper()
    )


# ----------------------------------------------------------------------
# Samples
# ----------------------------------------------------------------------

SAMPLES = [
    ("\u77ed\u53e5\u3002", 500, 480),
    (
        "\u7b2c\u4e00\u6bb5\u5185\u5bb9\u3002"
        "\u7b2c\u4e8c\u6bb5\u5185\u5bb9\uff01"
        "\u7b2c\u4e09\u6bb5\u5185\u5bb9\uff1f"
        "\u7b2c\u56db\u6bb5\u5185\u5bb9\uff1b"
        "\u7b2c\u4e94\u6bb5\u5185\u5bb9\u2026\u2026",
        500,
        480,
    ),
    (
        "\u4ed6\u8bf4\uff1a\u201c\u4f60\u597d\u3002\u201d"
        "\u7136\u540e\u8d70\u4e86\u3002\u5979\u6ca1\u6709\u56de\u7b54\u3002",
        60,
        0,
    ),
    ("\u8fd9\u662f\u4e00\u4e2a\u5f88\u957f\u7684\u6bb5\u843d\uff0c" * 40, 200, 150),
    ("\u6ca1\u6709\u6807\u70b9\u7684\u8d85\u957f\u6587\u672c" * 60, 120, 0),
    (
        "\u7b2c\u4e00\u6bb5\u3002\n\n\u7b2c\u4e8c\u6bb5\u3002\n\n\n\u7b2c\u4e09\u6bb5\u3002",
        500,
        480,
    ),
    ("Mixed \u4e2d\u6587 and English text. \u7b2c\u4e8c\u53e5 here!", 60, 40),
    ("a" * 1200, 60, 0),
    ("", 500, 480),
    ("   \n\n  ", 500, 480),
    (
        "\u7532\u3002\u4e59\u3002\u4e19\u3002\u4e01\u3002"
        "\u620a\u3002\u5df1\u3002\u5e9a\u3002\u8f9b\u3002",
        20,
        10,
    ),
    ("Hello world. This is a test! Does it work? Yes; it does.", 30, 20),
    (
        "\u5f15\u53f7\u6d4b\u8bd5\uff1a\u201c\u7532\u3002\u201d"
        "\u2018\u4e59\u3002\u2019\u300a\u4e19\u300b\u3002",
        60,
        0,
    ),
    (
        "\u6362\u884c\n\u5728\u6bb5\u843d\u5185\n\u5e94\u8be5\u88ab\u5408\u5e76\u3002\u7ed3\u675f\u3002",
        500,
        480,
    ),
    (
        "\u7701\u7565\u53f7\u2026\u2026\u540e\u9762\u8fd8\u6709\u5185\u5bb9\u3002"
        "\u2026\u2026\u518d\u6765\u4e00\u6bb5\u3002",
        60,
        50,
    ),
]


def main() -> None:
    target = Path(
        sys.argv[1] if len(sys.argv) > 1 else "build/python-reference.json"
    )

    cases = [
        {
            "text": text,
            "maxChars": max_chars,
            "minChars": min_chars,
            "chunks": split_text(text, max_chars=max_chars, min_chars=min_chars),
        }
        for text, max_chars, min_chars in SAMPLES
    ]

    sec_samples = [
        {"nowMs": now_ms, "token": sec_ms_gec(now_ms)}
        for now_ms in (1_700_000_000_000, 1_731_234_567_890, 1_750_000_000_000)
    ]

    long_text = "".join(chr(0x4E00 + (i % 1000)) for i in range(3000))

    byte_samples = [
        {
            "text": text,
            "limit": limit,
            "chunks": split_by_byte_length_python(text, limit),
        }
        for text, limit in (
            (escape(long_text), 4096),
            ("hello world " * 500, 200),
            (escape("\u5305\u542b & \u7b26\u53f7 <tag> \u7684\u6587\u672c\u3002" * 200), 100),
            ("abcdefghij " * 400, 50),
            ("\u4e2d\u6587\u6bb5\u843d " * 300, 64),
        )
    ]

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {"cases": cases, "secMsGec": sec_samples, "byteSplit": byte_samples},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    summary = (
        f"wrote {target}: {len(cases)} split cases, "
        f"{len(sec_samples)} token samples, {len(byte_samples)} byte-split cases"
    )

    try:
        print(summary)
    except UnicodeEncodeError:
        print(summary.encode("ascii", "replace").decode("ascii"))


if __name__ == "__main__":
    main()
