// Applies the chosen spelling (dialect.ts) to the program's own words, as they appear on the page, and keeps doing so as the page changes. It never touches
// what comes from the music (song, album and artist names, paths, playlist names): only the places listed in SCOPES are looked at, and a few things inside
// them are skipped. Stored in this window's own storage.

import { type Dialect, DEFAULT_DIALECT, cleanDialect, convertText } from "./dialect";

const KEY = "mediaverse.language.v1";
/** Where the program's own text lives: the settings, the page names at the top, and the tooltips of the player bar. */
const TEXT_SCOPES = "#settings-page, [data-page], header";
const ATTRIBUTE_SCOPES = `${TEXT_SCOPES}, .player-bar`;
/** Inside those, what comes from the library or the person and must be left alone. */
const SKIP = "input, textarea, script, style, code, [data-content], .organize-row, .organize-dup, #player-title, #player-detail, .pl-side";
const ATTRIBUTES = ["title", "aria-label", "placeholder"];

let dialect: Dialect = DEFAULT_DIALECT;
try {
  dialect = cleanDialect(window.localStorage.getItem(KEY));
} catch {
  dialect = DEFAULT_DIALECT;
}

export const currentDialect = (): Dialect => dialect;

const inside = (node: Node, scopes: string): boolean => {
  const element = node instanceof Element ? node : node.parentElement;
  return !!element && !!element.closest(scopes) && !element.closest(SKIP);
};

function convertTextNodes(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (!text.trim() || !inside(node, TEXT_SCOPES)) continue;
    const next = convertText(text, dialect);
    if (next !== text) node.nodeValue = next;
  }
}

function convertAttributes(root: Element): void {
  const all = [root, ...root.querySelectorAll<Element>("[title], [aria-label], [placeholder]")];
  for (const element of all) {
    if (!inside(element, ATTRIBUTE_SCOPES)) continue;
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const next = convertText(value, dialect);
      if (next !== value) element.setAttribute(name, next);
    }
  }
}

function convertSubtree(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    if (inside(node, TEXT_SCOPES)) {
      const text = node.nodeValue ?? "";
      const next = convertText(text, dialect);
      if (next !== text) node.nodeValue = next;
    }
    return;
  }
  if (node instanceof Element) {
    convertTextNodes(node);
    convertAttributes(node);
  }
}

/** Starts the spelling, and keeps it up as the page changes. */
export function initDialect(): void {
  document.documentElement.lang = dialect;
  convertSubtree(document.body);
  const pending = new Set<Node>();
  let queued = false;
  const flush = (): void => {
    queued = false;
    for (const node of pending) if (node.isConnected) convertSubtree(node);
    pending.clear();
  };
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") m.addedNodes.forEach((n) => pending.add(n));
      else if (m.type === "characterData") pending.add(m.target);
      else if (m.target instanceof Element) pending.add(m.target);
    }
    if (!queued && pending.size) {
      queued = true;
      requestAnimationFrame(flush);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
}

/** Saves the choice and applies it. Words already on the page in another spelling are changed too (both directions). */
export function setDialect(next: Dialect): void {
  dialect = cleanDialect(next);
  try {
    window.localStorage.setItem(KEY, dialect);
  } catch {
    // kept until the window closes
  }
  document.documentElement.lang = dialect;
  convertSubtree(document.body);
}
