// The lyrics timing editor (owner, 2026-11-22): one text area that behaves like a word processor (select several lines, copy, cut and paste them between other lines,
// Enter splits a line, Backspace and Delete join lines, Ctrl+Z undoes, spelling mistakes are underlined and right-click offers corrections) with a time stamp and a "now"
// button at the start of each line. The browser handles typing inside a line (and the spell checker with it); everything that changes the lines (Enter, deleting across
// lines, paste, cut, undo) is done here on the list of lines (`lyrics-edit.ts`) and the lines are drawn again. Text is set with textContent only.

import { el } from "./dom";
import { type Edit, History, type Pos, deleteRange, insertText, joinWithNext, joinWithPrevious, ordered, sameWords, splitLine, textBetween } from "./lyrics-edit";
import { type SyncLine, stampText } from "./lyrics-sync";

export type TimingEditorOptions = {
  /** Where the song is now, in ms, or null when this song is not playing. */
  nowMs: () => number | null;
  /** Play the song from this time (ms). */
  playFrom: (ms: number) => void;
  /** The lines changed (words, times, or both). */
  changed: (lines: SyncLine[]) => void;
};

export type TimingEditor = {
  element: HTMLElement;
  lines: () => SyncLine[];
  /** New lyrics (another candidate): the undo history starts again. */
  set: (lines: SyncLine[]) => void;
  /** The same words with new times: only the time buttons change; the text, caret and scrolling stay. */
  setTimes: (lines: SyncLine[]) => void;
  /** Marks the line being sung; with `follow` the area scrolls to keep it a third of the way down (not for a few seconds after the person scrolled). */
  highlight: (index: number, follow: boolean) => void;
  /** Gives one line a time (the place the song is at). */
  stamp: (index: number, ms: number) => void;
};

const timeText = (line: SyncLine): string => (line.ms === null ? "–:–" : stampText(line.ms));

export function createTimingEditor(options: TimingEditorOptions): TimingEditor {
  const root = el("div", "te");
  root.contentEditable = "true";
  root.spellcheck = true;
  root.lang = "en";
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");
  root.setAttribute("aria-label", "Lyrics, one line per row, each with its time");
  root.setAttribute("autocorrect", "off");
  root.setAttribute("autocapitalize", "off");

  let lines: SyncLine[] = [{ text: "", ms: null }];
  let history = new History();
  let current = -1;
  let scrolledAt = 0;
  root.addEventListener("wheel", () => (scrolledAt = Date.now()), { passive: true });

  const rowElement = (row: number): HTMLElement | null => root.children[row] as HTMLElement | null;
  const wordsOf = (row: number): HTMLElement | null => rowElement(row)?.querySelector<HTMLElement>(".te-words") ?? null;

  function stampRow(row: number, ms: number): void {
    commit(lines.map((l, i) => (i === row ? { ...l, ms: Math.max(0, Math.round(ms)), mine: true } : l)), "", true);
  }

  function buildRow(line: SyncLine, row: number): HTMLElement {
    const box = el("div", line.ms === null ? "te-row" : line.mine ? "te-row is-timed is-mine" : "te-row is-timed");
    box.dataset.row = String(row);
    const gutter = el("span", "te-gutter");
    gutter.contentEditable = "false";
    // Pressing a button must not move the caret or drop the selection.
    gutter.addEventListener("mousedown", (event) => event.preventDefault());
    if (line.text !== "") {
      const time = el("button", "sync-time", timeText(line));
      time.type = "button";
      time.title = "Play from just before this line";
      time.addEventListener("click", () => {
        const at = lines[row]?.ms;
        if (at !== null && at !== undefined) options.playFrom(at);
      });
      const now = el("button", "sync-nudge", "now");
      now.type = "button";
      now.title = "Give this line the place the song is at now (Ctrl+Enter does it for the line the caret is in)";
      now.addEventListener("click", () => {
        const ms = options.nowMs();
        if (ms !== null) stampRow(row, ms);
      });
      gutter.append(time, now);
    }
    const words = el("span", "te-words");
    if (line.text === "") words.append(document.createElement("br"));
    else words.textContent = line.text;
    box.append(gutter, words);
    if (row === current) box.classList.add("is-current");
    return box;
  }

  function render(caret?: Pos): void {
    const scroll = root.scrollTop;
    root.replaceChildren(...lines.map(buildRow));
    root.scrollTop = scroll;
    if (caret) setCaret(caret);
  }

  /** The place in the lyrics a point in the page stands for. */
  function posOf(node: Node, offset: number): Pos {
    if (node === root) {
      const row = Math.min(offset, lines.length);
      return row >= lines.length ? { row: lines.length - 1, col: lines[lines.length - 1]!.text.length } : { row, col: 0 };
    }
    const element = node instanceof Element ? node : node.parentElement;
    const rowEl = element?.closest<HTMLElement>(".te-row");
    if (!rowEl) return { row: 0, col: 0 };
    const row = Math.min(Number(rowEl.dataset.row ?? 0), lines.length - 1);
    const words = rowEl.querySelector<HTMLElement>(".te-words");
    if (!words || !words.contains(node)) {
      return node === rowEl && offset >= rowEl.childNodes.length ? { row, col: lines[row]!.text.length } : { row, col: 0 };
    }
    const range = document.createRange();
    range.setStart(words, 0);
    range.setEnd(node, offset);
    return { row, col: Math.min(range.toString().length, lines[row]!.text.length) };
  }

  function selection(): { anchor: Pos; focus: Pos } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
    if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
    return { anchor: posOf(sel.anchorNode, sel.anchorOffset), focus: posOf(sel.focusNode, sel.focusOffset) };
  }

  function setCaret(pos: Pos): void {
    const words = wordsOf(Math.min(pos.row, lines.length - 1));
    const sel = window.getSelection();
    if (!words || !sel) return;
    const range = document.createRange();
    const text = words.firstChild;
    if (text instanceof Text) range.setStart(text, Math.min(pos.col, text.length));
    else range.setStart(words, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    words.scrollIntoView({ block: "nearest" });
  }

  const caretNow = (): Pos => selection()?.focus ?? { row: 0, col: 0 };
  const snapshot = (): Edit => ({ lines, caret: caretNow() });

  /** A change to the lines: remembered for undo, drawn, reported. */
  function commit(next: SyncLine[], key: string, timesOnly = false): void {
    history.record(snapshot(), key);
    lines = next.length ? next : [{ text: "", ms: null }];
    if (timesOnly) updateTimes();
    options.changed(lines);
  }

  function apply(edit: Edit): void {
    history.record(snapshot());
    lines = edit.lines.length ? edit.lines : [{ text: "", ms: null }];
    render(edit.caret);
    options.changed(lines);
  }

  function updateTimes(): void {
    lines.forEach((line, row) => {
      const rowEl = rowElement(row);
      if (!rowEl) return;
      rowEl.classList.toggle("is-timed", line.ms !== null);
      rowEl.classList.toggle("is-mine", line.ms !== null && line.mine === true);
      const button = rowEl.querySelector<HTMLElement>(".sync-time");
      if (button) button.textContent = timeText(line);
    });
  }

  function undoRedo(redo: boolean): void {
    const state = snapshot();
    const step = redo ? history.redo(state) : history.undo(state);
    if (!step) return;
    lines = step.lines;
    render(step.caret);
    options.changed(lines);
  }

  root.addEventListener("beforeinput", (event) => {
    const type = event.inputType;
    if (type.startsWith("format")) {
      event.preventDefault();
      return;
    }
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      undoRedo(type === "historyRedo");
      return;
    }
    // Paste and cut are done in their own events (they have the clipboard).
    if (type === "insertFromPaste" || type === "deleteByCut" || type === "insertFromDrop") {
      event.preventDefault();
      return;
    }
    const sel = selection();
    if (!sel) return;
    const [from, to] = ordered(sel.anchor, sel.focus);
    const collapsed = from.row === to.row && from.col === to.col;
    if (type === "insertParagraph" || type === "insertLineBreak") {
      event.preventDefault();
      if (collapsed) apply(splitLine(lines, from));
      else {
        const removed = deleteRange(lines, from, to);
        apply(splitLine(removed.lines, removed.caret));
      }
      return;
    }
    if (type.startsWith("deleteContent") || type.startsWith("deleteWord") || type.startsWith("deleteSoftLine") || type.startsWith("deleteHardLine")) {
      const backward = type.endsWith("Backward");
      if (!collapsed) {
        event.preventDefault();
        apply(deleteRange(lines, from, to));
        return;
      }
      if (backward && from.col === 0) {
        event.preventDefault();
        if (from.row > 0) apply(joinWithPrevious(lines, from.row));
        return;
      }
      if (!backward && from.col === lines[from.row]!.text.length) {
        event.preventDefault();
        if (from.row < lines.length - 1) apply(joinWithNext(lines, from.row));
        return;
      }
      history.record(snapshot(), `delete:${from.row}`);
      return;
    }
    if (!collapsed && from.row !== to.row && type.startsWith("insert")) {
      // Typing over a selection that runs across lines: the selection goes, the typed text takes its place.
      event.preventDefault();
      const removed = deleteRange(lines, from, to);
      apply(insertText(removed.lines, removed.caret, event.data ?? ""));
      return;
    }
    history.record(snapshot(), `type:${from.row}`);
  });

  // The browser has changed the text of one line: take it into the lines.
  root.addEventListener("input", () => {
    const sel = selection();
    if (!sel) return;
    const row = sel.focus.row;
    const words = wordsOf(row);
    if (!words) return;
    const text = (words.textContent ?? "").replace(/ /g, " ").replace(/[\r\n]+/g, " ");
    const old = lines[row];
    if (!old || old.text === text) return;
    const blankChanged = (old.text === "") !== (text === "");
    lines = lines.map((l, i) => (i === row ? { ...l, text } : l));
    // The first letters typed into an empty line (or the last deleted from a line) change whether the line shows its time buttons: draw it again with the caret
    // where the browser left it, which is the end of what was typed into an empty line.
    if (blankChanged) render({ row, col: old.text === "" ? text.length : 0 });
    options.changed(lines);
  });

  root.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    const sel = selection();
    if (!text || !sel) return;
    const [from, to] = ordered(sel.anchor, sel.focus);
    const removed = deleteRange(lines, from, to);
    apply(insertText(removed.lines, removed.caret, text));
  });

  const copyOrCut = (event: ClipboardEvent, cut: boolean): void => {
    const sel = selection();
    if (!sel) return;
    const [from, to] = ordered(sel.anchor, sel.focus);
    if (from.row === to.row && from.col === to.col) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", textBetween(lines, from, to));
    if (cut) apply(deleteRange(lines, from, to));
  };
  root.addEventListener("copy", (event) => copyOrCut(event, false));
  root.addEventListener("cut", (event) => copyOrCut(event, true));
  // Dragging text about would tear the lines apart: copy and paste do the job.
  root.addEventListener("dragstart", (event) => event.preventDefault());
  root.addEventListener("drop", (event) => event.preventDefault());

  root.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") {
      event.preventDefault();
      undoRedo(event.shiftKey);
    } else if (mod && key === "y") {
      event.preventDefault();
      undoRedo(true);
    } else if (mod && event.key === "Enter") {
      // Time the line the caret is in as it starts, and move on to the next one: tap along with the song from the keyboard.
      event.preventDefault();
      const ms = options.nowMs();
      const row = caretNow().row;
      if (ms === null || !lines[row]) return;
      stampRow(row, ms);
      const next = lines.findIndex((l, i) => i > row && l.text !== "");
      if (next >= 0) setCaret({ row: next, col: 0 });
    }
  });

  return {
    element: root,
    lines: () => lines,
    set(next) {
      lines = next.length ? next : [{ text: "", ms: null }];
      history = new History();
      current = -1;
      render();
    },
    setTimes(next) {
      if (!sameWords(lines, next)) {
        lines = next;
        render();
        return;
      }
      lines = next;
      updateTimes();
    },
    highlight(index, follow) {
      if (index === current) return;
      rowElement(current)?.classList.remove("is-current");
      current = index;
      const row = rowElement(index);
      row?.classList.add("is-current");
      if (row && follow && Date.now() - scrolledAt > 4000) root.scrollTo({ top: Math.max(0, row.offsetTop - root.clientHeight / 3), behavior: "smooth" });
    },
    stamp(index, ms) {
      if (lines[index]) stampRow(index, ms);
    },
  };
}
