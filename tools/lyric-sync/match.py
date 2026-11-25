"""How well do a candidate's lyrics match what the AI heard?

    similarity(candidate_text, transcript_text) -> {"recall", "precision", "score", ...}

Both texts are reduced to comparable words first (case, accents, punctuation, "&"/"and", digits and Roman numerals as words, the
usual spelling variants), sung vocables ("oh", "whoa", "yeah", "la la") are wildcards that are left out of the count on both sides
(a transcript rarely agrees with the printed lyrics on them), then the words are aligned in order (repeats of a chorus are matched
to the same chorus lines), with near-misses counted as matches ("gonna"/"going to", "ya"/"you", a misheard letter or two).
 recall     share of the candidate's words the AI also heard (low when the candidate has lines the singer does not sing, or the AI
            missed a quiet part)
 precision  share of what the AI heard that is in the candidate (low for a different song, or a transcript of noise)
 score      the smaller of the two (a different song fails one of them; a transcript that only holds part of the song fails recall,
            so score is also reported against the transcript's length: `coverage`)
"""
from __future__ import annotations

import difflib
import re
import unicodedata

VOCABLES = {
    "oh", "ooh", "oooh", "ohh", "ah", "aah", "aaah", "ahh", "whoa", "woah", "woo", "woah", "wo", "oo", "uh", "um", "hmm", "mm", "mmm", "hm", "ha", "hah",
    "yeah", "yea", "yeh", "ya", "hey", "heh", "eh", "ay", "ayy", "ayo", "la", "na", "da", "doo", "dum", "ba", "bom", "sha", "shoo", "wah", "ooo", "ohhh",
    "huh", "uhh", "ahhh", "yo", "ow", "oi", "ey",
}
ROMAN = {"i": "one", "ii": "two", "iii": "three", "iv": "four", "v": "five", "vi": "six", "vii": "seven", "viii": "eight", "ix": "nine", "x": "ten"}
NUMBERS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten", "11": "eleven",
    "12": "twelve", "13": "thirteen", "14": "fourteen", "15": "fifteen", "16": "sixteen", "17": "seventeen", "18": "eighteen", "19": "nineteen", "20": "twenty",
}
SPELLING = {"gonna": "going to", "wanna": "want to", "gotta": "got to", "cause": "because", "cos": "because", "til": "until", "till": "until", "tho": "though", "thru": "through",
            "ya": "you", "yer": "your", "em": "them", "nothin": "nothing", "somethin": "something", "lovin": "loving", "goin": "going", "n": "and", "ain't": "aint",
            "alright": "all right", "okay": "ok", "everybody": "everybody", "gimme": "give me", "lemme": "let me", "dunno": "do not know", "kinda": "kind of"}


def words(text: str, drop_vocables: bool = True) -> list[str]:
    """The comparable words of a text."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = text.replace("&", " and ").replace("’", "'")
    out: list[str] = []
    for raw in re.findall(r"[A-Za-z0-9']+", text):
        w = raw.strip("'")
        if not w:
            continue
        lower = w.lower()
        if raw.isupper() and lower in ROMAN and len(raw) > 1:  # "III" in a title, not the word "I"
            lower = ROMAN[lower]
        lower = NUMBERS.get(lower, lower)
        for piece in SPELLING.get(lower, lower).split():
            piece = piece.replace("'", "")
            if drop_vocables and piece in VOCABLES:
                continue
            if drop_vocables and re.fullmatch(r"(?:la|na|da|oh|ah|ooh|woah|whoa|hey|yeah)+", piece):
                continue
            out.append(piece)
    return out


def _near(a: str, b: str) -> bool:
    if a == b:
        return True
    if min(len(a), len(b)) < 4:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


def similarity(candidate: str, transcript: str) -> dict:
    cand = words(candidate)
    heard = words(transcript)
    if len(cand) < 8 or len(heard) < 8:
        return {"recall": 0.0, "precision": 0.0, "score": 0.0, "coverage": 0.0, "cand_words": len(cand), "heard_words": len(heard)}
    # Near-misses are brought to the candidate's spelling first, so that the in-order alignment below sees them as the same word.
    vocabulary = sorted(set(cand))
    cache: dict[str, str] = {}

    def snap(w: str) -> str:
        if w in cache:
            return cache[w]
        found = w
        if w not in vocabulary:
            for v in difflib.get_close_matches(w, vocabulary, n=1, cutoff=0.8):
                if _near(w, v):
                    found = v
                    break
        cache[w] = found
        return found

    snapped = [snap(w) for w in heard]
    matcher = difflib.SequenceMatcher(None, cand, snapped, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    recall = matched / len(cand)
    precision = matched / len(heard)
    return {
        "recall": round(recall, 3),
        "precision": round(precision, 3),
        "score": round(min(recall, precision), 3),
        "coverage": round(matched / max(len(heard), 1), 3),
        "cand_words": len(cand),
        "heard_words": len(heard),
    }
