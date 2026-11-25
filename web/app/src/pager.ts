// The page navigation bar for long lists: Previous, 1 2 3 … 16, Next, and "Showing 801–900 of 1,600 songs".

import { el } from "./dom";
import { pageCount, pageItems, rangeText } from "./pager-pages";

/** The navigation bar for a 0-based `page`; `goTo` is called with the 0-based page wanted. Returns nothing to draw when everything fits one page. */
export function pagerBar(page: number, size: number, total: number, noun: string, goTo: (page: number) => void): HTMLElement {
  const bar = el("nav", "pager");
  bar.setAttribute("aria-label", "Pages");
  bar.append(el("span", "pager-range", rangeText(page, size, total, noun)));
  const pages = pageCount(total, size);
  if (pages <= 1) return bar;
  const buttons = el("div", "pager-buttons");
  const make = (label: string, target: number, disabled: boolean, extra = ""): HTMLButtonElement => {
    const b = el("button", `secondary pager-button${extra}`, label);
    b.type = "button";
    b.disabled = disabled;
    b.addEventListener("click", () => goTo(target));
    return b;
  };
  buttons.append(make("‹ Previous", page - 1, page <= 0, " pager-step"));
  for (const item of pageItems(page + 1, pages)) {
    if (item === "gap") {
      const gap = el("span", "pager-gap", "…");
      gap.setAttribute("aria-hidden", "true");
      buttons.append(gap);
      continue;
    }
    const b = make(String(item), item - 1, false, item - 1 === page ? " is-active" : "");
    b.setAttribute("aria-label", `Page ${item}`);
    if (item - 1 === page) b.setAttribute("aria-current", "page");
    buttons.append(b);
  }
  buttons.append(make("Next ›", page + 1, page >= pages - 1, " pager-step"));
  bar.append(buttons);
  return bar;
}
