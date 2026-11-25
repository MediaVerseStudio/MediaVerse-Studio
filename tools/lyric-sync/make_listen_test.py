"""Builds a local page for listening to the aligner's timing (nothing in the library is touched or copied into it).

    python make_listen_test.py <songs.json> <aligned.json> <out-folder> [more aligned .json with their own songs.json: pairs]
        [--staged <folder of .lrc>] [--extra "<song.json>=<aligned.json>"]

It copies a handful of songs into <out-folder>\\audio and writes <out-folder>\\index.html: pick a song, play it, and watch the lines
highlight. For songs that already have timing there are two buttons, "Existing timing" and "New timing" (the aligner's), so the two
can be compared by ear in the same place; "Earlier / Later" nudge the timing of the version being shown (0.1 s) and tell the amount,
so a steady offset can be read off. Click a line to jump there.
"""
from __future__ import annotations

import html
import json
import shutil
import sys
from pathlib import Path

from common import parse_lrc
from library_jobs import BIAS_S, USUAL_OFFSET_MS, verdict


def song_entry(index: int, path: str, existing: list[dict] | None, new: list[dict], note: str, out: Path) -> dict:
    audio = out / "audio" / f"{index}.mp3"
    audio.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, audio)
    return {"title": Path(path).stem, "note": note, "audio": f"audio/{index}.mp3", "existing": existing, "new": new}


def new_lines(aligned: list[dict]) -> list[dict]:
    """The aligner's line starts, 0.2 s earlier (see library_jobs.BIAS_S); lines it could not place are left out."""
    return [{"t": round(max(0.0, a["start"] - BIAS_S), 2), "text": a["text"], "flag": ", ".join(a.get("flags", []))} for a in aligned if a["start"] is not None]


def pick(songs_file: str, aligned_file: str, want: dict[str, int], out: Path, first: int) -> list[dict]:
    truth = {s["path"]: [l for l in s["lines"] if l["text"].strip()] for s in json.loads(Path(songs_file).read_text(encoding="utf-8"))}
    entries: list[dict] = []
    taken: dict[str, int] = {}
    for run in json.loads(Path(aligned_file).read_text(encoding="utf-8")):
        if "error" in run or run["path"] not in truth:
            continue
        lines = truth[run["path"]]
        errors = [(l["ms"] / 1000, a["start"] * 1000 - l["ms"]) for l, a in zip(lines, run["lines"]) if a["start"] is not None]
        if len(errors) < 8:
            continue
        kind = verdict(errors)["verdict"]
        if taken.get(kind, 0) >= want.get(kind, 0):
            continue
        taken[kind] = taken.get(kind, 0) + 1
        existing = [{"t": l["ms"] / 1000, "text": l["text"]} for l in lines]
        entries.append(song_entry(first + len(entries), run["path"], existing, new_lines(run["lines"]), f"checked: {kind}", out))
    return entries


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lyric timing listen test</title><style>
:root{color-scheme:dark;--bg:#0f0b09;--ink:#f4ece5;--dim:#a99c92;--accent:#e88647;--card:#1b1411}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;padding:16px;max-width:900px;margin-inline:auto}
h1{font-size:1.2rem;margin:.2em 0}p.hint{color:var(--dim);margin:.2em 0 1em}
#songs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}button{background:var(--card);color:var(--ink);border:1px solid #3a2d26;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer}
button.on{border-color:var(--accent);color:var(--accent)}button:focus-visible{outline:2px solid var(--accent)}
audio{width:100%;margin:8px 0}#now{font-size:1.7rem;min-height:3.4em;padding:12px;background:var(--card);border-radius:10px;margin:8px 0}
#controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}#nudge{color:var(--dim)}
#lines p{margin:0;padding:2px 8px;color:var(--dim);cursor:pointer;border-radius:6px}#lines p.now{color:var(--ink);background:#2a1d16}
#lines small{color:#6f635b;margin-right:8px;font-variant-numeric:tabular-nums}</style></head><body>
<h1>Lyric timing: listen test</h1>
<p class="hint">Pick a song, press play, and watch whether each line lights up when it is sung. Where a song already has timing, switch between
<b>Existing</b> and <b>New</b> while it plays. Use <b>Earlier / Later</b> to move the shown timing in 0.1 s steps: the amount you needed is the
error. Click a line to jump to it. A yellow warning sign marks a line the aligner is unsure about (hover for why). Nothing here changes any song or the library.</p>
<div id="songs"></div><div id="meta" class="hint"></div><audio id="a" controls preload="metadata"></audio>
<div id="controls"><span id="which"></span><button id="earlier">Earlier 0.1 s</button><button id="later">Later 0.1 s</button><span id="nudge"></span></div>
<div id="now"></div><div id="lines"></div>
<script>
const SONGS = __SONGS__;
const $ = (id) => document.getElementById(id);
let song = null, version = "new", shift = 0, shown = [];
const audio = $("a");
function lines() { return (song[version] || []).map((l) => ({ t: l.t + shift, text: l.text, flag: l.flag })); }
function build() {
  shown = lines();
  $("lines").replaceChildren(...shown.map((l, i) => { const p = document.createElement("p"); const s = document.createElement("small");
    s.textContent = `${Math.floor(l.t / 60)}:${(l.t % 60).toFixed(1).padStart(4, "0")}`; p.append(s, l.text); if (l.flag) { const w = document.createElement('span'); w.textContent = '  \u26A0'; w.title = 'Check this line: ' + l.flag; w.style.color = '#e8c547'; p.append(w); } p.onclick = () => { audio.currentTime = Math.max(0, l.t - 0.2); audio.play(); }; return p; }));
  $("nudge").textContent = shift ? `shifted ${shift > 0 ? "+" : ""}${shift.toFixed(1)} s` : "";
  $("which").replaceChildren(...["existing", "new"].filter((v) => song[v]).map((v) => { const b = document.createElement("button"); b.textContent = v === "new" ? "New timing" : "Existing timing";
    b.className = v === version ? "on" : ""; b.onclick = () => { version = v; shift = 0; build(); }; return b; }));
  tick();
}
function tick() {
  const t = audio.currentTime; let at = -1; for (let i = 0; i < shown.length; i++) if (shown[i].t <= t) at = i;
  $("now").textContent = at >= 0 ? shown[at].text : "";
  [...$("lines").children].forEach((p, i) => { p.className = i === at ? "now" : ""; if (i === at && !audio.paused) p.scrollIntoView({ block: "nearest" }); });
}
function choose(i) { song = SONGS[i]; version = song.new ? "new" : "existing"; shift = 0; audio.src = song.audio;
  $("meta").textContent = `${song.title} (${song.note})`; [...$("songs").children].forEach((b, k) => b.className = k === i ? "on" : ""); build(); }
SONGS.forEach((s, i) => { const b = document.createElement("button"); b.textContent = s.title.slice(0, 38); b.onclick = () => choose(i); $("songs").append(b); });
$("earlier").onclick = () => { shift -= 0.1; build(); }; $("later").onclick = () => { shift += 0.1; build(); };
audio.addEventListener("timeupdate", tick); setInterval(() => { if (!audio.paused) tick(); }, 100);
choose(0);
</script></body></html>"""


def main() -> None:
    args = sys.argv[1:]
    out = Path(args[2])
    entries: list[dict] = []
    # the checked songs: a few of each verdict
    entries += pick(args[0], args[1], {"fits": 2, "shifted": 2, "drifts": 1, "does-not-fit": 1}, out, len(entries))
    for spec in [a for a in args[3:] if "=" in a]:  # other songs: <songs.json>=<aligned.json> (e.g. the Spanish song)
        songs_file, aligned_file = spec.split("=", 1)
        entries += pick(songs_file, aligned_file, {"fits": 1, "shifted": 1, "drifts": 1, "does-not-fit": 1}, out, len(entries))
    if "--staged" in args:
        folder = Path(args[args.index("--staged") + 1])
        summary = {Path(s["path"]).stem: s["path"] for s in json.loads((folder / "summary.json").read_text(encoding="utf-8"))}
        for lrc in sorted(folder.glob("*.lrc"))[:3]:
            if lrc.stem in summary:
                flag_file = lrc.with_suffix(".flags.json")
                flagged = json.loads(flag_file.read_text(encoding="utf-8")) if flag_file.exists() else {}
                lines = [{"t": l.ms / 1000, "text": l.text, "flag": ", ".join(flagged.get(str(i), []))} for i, l in enumerate(parse_lrc(lrc.read_text(encoding="utf-8")))]
                entries.append(song_entry(len(entries), summary[lrc.stem], None, lines, "had words but no timing: new timing only", out))
    (out / "index.html").write_text(PAGE.replace("__SONGS__", json.dumps(entries, ensure_ascii=False)), encoding="utf-8")
    print(f"{len(entries)} songs -> {out / 'index.html'}")


if __name__ == "__main__":
    main()
