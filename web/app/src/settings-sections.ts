// Settings as a list of sections on the left with one shown at a time (D32, after Zune's settings). The last
// section chosen is remembered on this computer. Arrow keys move between sections.

const KEY = "mediaverse.settings-section";

export function initSettingsSections(root: HTMLElement): { show: (name: string) => void } {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>("[data-settings-section]")];
  const panels = [...root.querySelectorAll<HTMLElement>("[data-settings-panel]")];

  function show(name: string): void {
    const known = tabs.some((t) => t.dataset.settingsSection === name) ? name : (tabs[0]?.dataset.settingsSection ?? "");
    for (const tab of tabs) {
      const on = tab.dataset.settingsSection === known;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== known;
    try {
      localStorage.setItem(KEY, known);
    } catch {
      // not remembered this time
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => show(tab.dataset.settingsSection ?? ""));
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(index + step + tabs.length) % tabs.length];
      show(next.dataset.settingsSection ?? "");
      next.focus();
    });
  });

  // When a save is refused, its reasons are listed in Lookups; show them rather than leave them hidden.
  const problems = root.querySelector<HTMLElement>("#settings-problems");
  if (problems) {
    new MutationObserver(() => {
      if (!problems.hidden) show(problems.closest<HTMLElement>("[data-settings-panel]")?.dataset.settingsPanel ?? "");
    }).observe(problems, { attributes: true, attributeFilter: ["hidden"], childList: true });
  }

  let saved = "";
  try {
    saved = localStorage.getItem(KEY) ?? "";
  } catch {
    saved = "";
  }
  show(saved);
  return { show };
}
