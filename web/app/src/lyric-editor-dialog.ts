// The lyrics editor window (owner, 2026-11-20): one song's words in a large, easy-to-read text editor with spell checking (red underlines and
// right-click suggestions come from the system's spell checker through the program's right-click menu), and the picture of the booklet page
// the words were read from beside it, so every line can be compared with the print. Opens over the page; Previous and Next move between songs.
// Text is set with textContent / value; the picture is a blob made from the page's own data.

import { blobFromBase64 } from "./cover-util";
import { el } from "./dom";

export type EditorSong = {
  /** "01  The Good Days" */
  title: string;
  words: string;
  /** The booklet page as base64 JPEG, when there is one. */
  picture: string | null;
  /** "Page 12: THE GOOD DAYS, photo 4" */
  source: string;
};

/** How many lines of words (empty lines between stanzas are not counted). */
export function lineCount(words: string): number {
  return words.split(/\r?\n/).filter((l) => l.trim() !== "").length;
}

/** The zoom steps of the picture, as a percentage of the width of its area. */
export const ZOOMS = [60, 80, 100, 140, 200] as const;

/**
 * Opens the editor over the page. `songs` are the songs that have words, in order; `start` is the one to show first.
 * `changed(index, words)` is called whenever the words of a song change; `closed()` when the window is closed.
 */
export function openLyricEditor(songs: EditorSong[], start: number, changed: (index: number, words: string) => void, closed: () => void): void {
  if (songs.length === 0) return;
  let index = Math.min(Math.max(start, 0), songs.length - 1);
  let zoom = 2; // 100%
  let url: string | null = null;

  const dialog = el("dialog", "lyric-editor");
  dialog.setAttribute("aria-label", "Lyrics editor");

  const heading = el("h2", "lyric-editor-title");
  const source = el("span", "field-hint");
  const previous = el("button", "secondary", "‹ Previous song");
  const next = el("button", "secondary", "Next song ›");
  const close = el("button", undefined, "Done");
  for (const button of [previous, next, close]) button.type = "button";
  const top = el("div", "lyric-editor-top");
  const titles = el("div", "lyric-editor-titles");
  titles.append(heading, source);
  const nav = el("div", "lyric-editor-nav");
  nav.append(previous, next, close);
  top.append(titles, nav);

  // the picture side
  const pictureBox = el("div", "lyric-editor-picture");
  const tools = el("div", "lyric-editor-tools");
  const smaller = el("button", "secondary", "−");
  const larger = el("button", "secondary", "+");
  const zoomText = el("span", "field-hint");
  for (const button of [smaller, larger]) button.type = "button";
  smaller.setAttribute("aria-label", "Smaller picture");
  larger.setAttribute("aria-label", "Larger picture");
  tools.append(smaller, zoomText, larger);
  const scroller = el("div", "lyric-editor-scroll");
  const picture = el("img");
  picture.alt = "The booklet page these words were read from";
  const nothing = el("p", "field-hint", "There is no picture for this song.");
  scroller.append(picture, nothing);
  pictureBox.append(tools, scroller);

  // the text side
  const textBox = el("div", "lyric-editor-text");
  const area = el("textarea", "lyric-editor-area");
  area.spellcheck = true;
  area.lang = "en";
  area.setAttribute("aria-label", "Lyrics");
  area.setAttribute("autocorrect", "off");
  const count = el("span", "field-hint");
  textBox.append(area, count);

  const body = el("div", "lyric-editor-body");
  body.append(pictureBox, textBox);
  dialog.append(top, body);

  function showZoom(): void {
    picture.style.width = `${ZOOMS[zoom]}%`;
    zoomText.textContent = `${ZOOMS[zoom]}%`;
    smaller.disabled = zoom === 0;
    larger.disabled = zoom === ZOOMS.length - 1;
  }

  function show(): void {
    const song = songs[index]!;
    heading.textContent = song.title;
    source.textContent = `${song.source} · song ${index + 1} of ${songs.length}`;
    area.value = song.words;
    count.textContent = `${lineCount(song.words)} lines`;
    previous.disabled = index === 0;
    next.disabled = index === songs.length - 1;
    if (url) URL.revokeObjectURL(url);
    url = null;
    if (song.picture) {
      url = URL.createObjectURL(blobFromBase64(song.picture, "image/jpeg"));
      picture.src = url;
    }
    picture.hidden = !song.picture;
    nothing.hidden = !!song.picture;
    scroller.scrollTop = 0;
    showZoom();
    area.focus();
  }

  area.addEventListener("input", () => {
    songs[index]!.words = area.value;
    count.textContent = `${lineCount(area.value)} lines`;
    changed(index, area.value);
  });
  previous.addEventListener("click", () => {
    index -= 1;
    show();
  });
  next.addEventListener("click", () => {
    index += 1;
    show();
  });
  smaller.addEventListener("click", () => {
    zoom = Math.max(0, zoom - 1);
    showZoom();
  });
  larger.addEventListener("click", () => {
    zoom = Math.min(ZOOMS.length - 1, zoom + 1);
    showZoom();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (url) URL.revokeObjectURL(url);
    dialog.remove();
    closed();
  });

  document.body.append(dialog);
  show();
  dialog.showModal();
}
