"""Shared pieces of the lyric-sync prototype (branch `lyric-sync`; research tools, not part of the shipped program).

Reads timed lyrics out of MP3 tags (ID3 SYLT, or LRC text in USLT, or a .lrc beside the song) and plain lyrics
(USLT), and turns lyrics text into lines.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from mutagen.id3 import ID3, ID3NoHeaderError

LRC_STAMP = re.compile(r"\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]")


@dataclass
class Line:
    ms: int
    text: str


def parse_lrc(text: str) -> list[Line]:
    """[mm:ss.xx] lines (several stamps per line allowed), in time order; header tags are ignored."""
    lines: list[Line] = []
    for raw in text.splitlines():
        stamps = list(LRC_STAMP.finditer(raw))
        if not stamps:
            continue
        words = raw[stamps[-1].end():].strip()
        for m in stamps:
            minutes, seconds, frac = int(m.group(1)), int(m.group(2)), m.group(3) or "0"
            ms = (minutes * 60 + seconds) * 1000 + int(frac.ljust(3, "0")[:3])
            lines.append(Line(ms, words))
    lines.sort(key=lambda l: l.ms)
    return lines


def read_lyrics(mp3: Path) -> tuple[list[Line], str]:
    """(timed lines, plain text) of a song: either may be empty."""
    timed: list[Line] = []
    plain = ""
    try:
        tags = ID3(str(mp3))
    except ID3NoHeaderError:
        tags = None
    if tags is not None:
        for frame in tags.getall("SYLT"):
            if getattr(frame, "format", 2) == 2 and frame.text:  # milliseconds
                timed = [Line(int(ms), str(text).strip()) for text, ms in frame.text]
                break
        for frame in tags.getall("USLT"):
            if str(frame.text).strip():
                plain = str(frame.text)
                break
    if not timed and plain and LRC_STAMP.search(plain):
        timed = parse_lrc(plain)
    lrc = mp3.with_suffix(".lrc")
    if not timed and lrc.exists():
        try:
            timed = parse_lrc(lrc.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            pass
    if not plain and timed:
        plain = "\n".join(l.text for l in timed)
    return timed, plain


def plain_lines(plain: str) -> list[str]:
    """The non-empty lines of a plain lyrics text, without stamps."""
    return [LRC_STAMP.sub("", l).strip() for l in plain.splitlines() if LRC_STAMP.sub("", l).strip()]


def ascii_share(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    return sum(c.isascii() for c in letters) / len(letters) if letters else 0.0
