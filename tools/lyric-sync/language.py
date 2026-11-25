"""A small language guesser for song lyrics, to choose the aligner model (English wav2vec2, or Meta's multilingual MMS).

Counts common function words of each language in the text; no downloads, no extra packages. Good enough to tell English from
Spanish, French, German, Portuguese and Italian lyrics; anything else (other scripts included) comes back as "other" and is
left alone for now.
"""
from __future__ import annotations

import re

WORDS = {
    "en": "the and you to of in is it that i me my we your for on with be this not are was but have all just like they what so no oh yeah when will can".split(),
    "es": "el la los las de que y en un una es por con no se lo mi tu te yo como pero mas para me ya si su al muy todo cuando hay quiero estoy esta eso".split(),
    "fr": "le la les de des et un une est que qui dans pour pas je tu il nous vous sur ce mon ma mes ton elle avec sans plus tout mais au".split(),
    "de": "der die das und ist nicht ich du er sie es wir ihr ein eine zu mit von den dem auf fur auch nur wie aber noch wenn mein dein".split(),
    "pt": "o a os as de que e em um uma nao por com se eu voce mais para como mas ja meu minha isso ele ela nos muito tudo quando".split(),
    "it": "il lo la i gli le di che e un una non per con mi ti io tu come ma piu sono questo anche tutto quando se del della".split(),
}
SETS = {code: set(words) for code, words in WORDS.items()}
# Letters that only occur in some languages' spelling (accents are stripped before alignment, but they are a good clue here).
CLUES = {"es": "ñ¿¡", "fr": "çœ", "de": "ßä", "pt": "ãõ", "it": ""}


def language_of(text: str) -> str:
    """"en", "es", "fr", "de", "pt", "it", or "other" (also for text with too few words to tell)."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return "other"
    if sum(not (c.isascii() or c in "àáâãäåçèéêëìíîïñòóôõöùúûüœß") for c in letters) / len(letters) > 0.2:
        return "other"  # another script
    words = re.findall(r"[a-zàáâãäåçèéêëìíîïñòóôõöùúûüœß']+", text.lower())
    if len(words) < 12:
        return "other"
    stripped = [re.sub(r"[àáâãäå]", "a", re.sub(r"[èéêë]", "e", re.sub(r"[ìíîï]", "i", re.sub(r"[òóôõö]", "o", re.sub(r"[ùúûü]", "u", w))))) for w in words]
    scores = {code: sum(w in vocabulary for w in stripped) for code, vocabulary in SETS.items()}
    for code, marks in CLUES.items():
        scores[code] += 3 * sum(text.lower().count(m) for m in marks)
    best = max(scores, key=lambda c: scores[c])
    ranked = sorted(scores.values(), reverse=True)
    if scores[best] < 4 or (len(ranked) > 1 and ranked[0] < ranked[1] * 1.15):
        return "other"
    return best


def model_for(language: str) -> str | None:
    """The aligner for a language: English has its own (better on English); other Latin-script languages use MMS; none otherwise."""
    if language == "en":
        return "w2v"
    if language in ("es", "fr", "de", "pt", "it"):
        return "mms"
    return None
