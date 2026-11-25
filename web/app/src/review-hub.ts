// The Review page's sub-navigation: which of its sections (flagged tracks, fix tags, artists, missing artwork, missing
// lyrics, audio defects) is showing, with the keyboard behaviour tabs should have.

export type ReviewTab = "flagged" | "fixtags" | "artists" | "ids" | "match" | "audit" | "ear" | "artwork" | "lyrics" | "defects";

export const REVIEW_TABS: ReviewTab[] = ["flagged", "fixtags", "artists", "ids", "match", "audit", "ear", "artwork", "lyrics", "defects"];

export function initReviewHub(root: HTMLElement, onShow: Record<ReviewTab, () => void>): { show: (tab: ReviewTab) => void; current: () => ReviewTab } {
  const buttons = new Map<ReviewTab, HTMLButtonElement>();
  const panels = new Map<ReviewTab, HTMLElement>();
  for (const tab of REVIEW_TABS) {
    buttons.set(tab, root.querySelector<HTMLButtonElement>(`.subnav-button[data-review=${tab}]`)!);
    panels.set(tab, root.querySelector<HTMLElement>(`#review-panel-${tab}`)!);
  }
  let active: ReviewTab = "flagged";

  function show(tab: ReviewTab): void {
    active = tab;
    for (const [name, button] of buttons) {
      const on = name === tab;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
      panels.get(name)!.hidden = !on;
    }
    onShow[tab]();
  }

  for (const [tab, button] of buttons) {
    button.addEventListener("click", () => show(tab));
    button.addEventListener("keydown", (event) => {
      const at = REVIEW_TABS.indexOf(tab);
      const next = event.key === "ArrowRight" ? REVIEW_TABS[(at + 1) % REVIEW_TABS.length] : event.key === "ArrowLeft" ? REVIEW_TABS[(at + REVIEW_TABS.length - 1) % REVIEW_TABS.length] : null;
      if (next) {
        event.preventDefault();
        show(next);
        buttons.get(next)!.focus();
      }
    });
  }
  return { show, current: () => active };
}
