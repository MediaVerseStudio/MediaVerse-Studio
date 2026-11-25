# Photo reader lab (Python, throw-away experiments)

Scripts used on 2026-11-21 to compare ways of reading lyric photos (D164). They are not part of the program.

- `vlm.py` / `batch.py` / `exp.py`: send photos to a vision model served by Ollama (`MODEL`, `PROMPT` environment variables) whole, in tiles, with thinking, or after turning the photo upright (`rot.json` = rotation per photo).
- `score.py`, `score2.py`, `cmp.py`, `mxword.py`: score a folder of reads against reference lyrics in `truth/` (not kept in the repository: it is the owner's lyrics). `mk_truth.py` builds `truth/` from the owner's corrected session; the other albums' reference was the lyrics already embedded in the library's files.
- `orient2.py`: an orientation test that did NOT work (the vision model invents plausible text in any orientation). What worked is the page reader's own confidence: read the photo turned 0/90/180/270 degrees and take the turn with the most confident letters (see D164).

The folder expects `lab\truth\*.txt` next to the scripts and photos listed in `photos.txt`. Outputs contain lyrics: never commit them.
