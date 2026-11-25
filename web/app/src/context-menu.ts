// A right-click menu for the desktop app (owner, 2026-11-04: select songs, then right-click for what to do with
// them, as in Windows Media Player). Arrow keys move, Enter chooses, Escape (or a click elsewhere, a scroll, the
// window losing focus) closes it. The first item is the default, shown in bold as Windows does. An item can open
// a submenu ("Add to playlist ›", D74): pointing at it or pressing → opens it, ← or Escape goes back.

import { el } from "./dom";

export type MenuItem =
  | { label: string; action: () => void; disabled?: boolean }
  | { label: string; submenu: MenuItem[]; disabled?: boolean }
  | "separator";

let open: { close: () => void } | null = null;

export function closeMenu(): void {
  open?.close();
}

type Level = { menu: HTMLElement; buttons: HTMLButtonElement[]; child: Level | null; opener: HTMLButtonElement | null };

/** Opens a menu at (x, y) in the window, kept inside the window. */
export function openMenu(x: number, y: number, items: MenuItem[], label = "Actions"): void {
  closeMenu();
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const levels: Level[] = [];

  function place(menu: HTMLElement, left: number, top: number, altLeft?: number): void {
    const rect = menu.getBoundingClientRect();
    const fitsRight = left + rect.width <= innerWidth;
    menu.style.left = `${Math.max(4, fitsRight ? left : (altLeft ?? left) - rect.width)}px`;
    menu.style.top = `${Math.max(4, top + rect.height > innerHeight ? innerHeight - rect.height - 4 : top)}px`;
  }

  function closeFrom(depth: number): void {
    while (levels.length > depth) levels.pop()!.menu.remove();
    const parent = levels.at(-1);
    if (parent) parent.child = null;
  }

  function build(list: MenuItem[], name: string, depth: number, left: number, top: number, altLeft?: number, opener: HTMLButtonElement | null = null): Level {
    const menu = el("div", "ctx-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", name);
    const level: Level = { menu, buttons: [], child: null, opener };
    list.forEach((item, index) => {
      if (item === "separator") {
        const line = el("div", "ctx-sep");
        line.setAttribute("role", "separator");
        menu.append(line);
        return;
      }
      const button = el("button", index === 0 && depth === 0 ? "ctx-item is-default" : "ctx-item", item.label);
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.disabled = item.disabled === true;
      button.tabIndex = -1;
      if ("submenu" in item) {
        button.classList.add("has-submenu");
        button.setAttribute("aria-haspopup", "menu");
        const openSub = (focusFirst: boolean): void => {
          if (level.child?.opener === button) return;
          closeFrom(depth + 1);
          const box = button.getBoundingClientRect();
          const sub = build(item.submenu, item.label, depth + 1, box.right - 2, box.top - 4, box.left + 2, button);
          level.child = sub;
          button.setAttribute("aria-expanded", "true");
          if (focusFirst) sub.buttons.find((b) => !b.disabled)?.focus();
        };
        button.addEventListener("click", () => openSub(true));
        button.addEventListener("pointerenter", () => openSub(false));
      } else {
        button.addEventListener("click", () => {
          close();
          item.action();
        });
        button.addEventListener("pointerenter", () => {
          if (level.child) closeFrom(depth + 1);
          button.focus();
        });
      }
      level.buttons.push(button);
      menu.append(button);
    });
    document.body.append(menu);
    levels.push(level);
    place(menu, left, top, altLeft);
    return level;
  }

  const root = build(items, label, 0, x, y, x);
  root.buttons.find((b) => !b.disabled)?.focus();

  const onKey = (event: KeyboardEvent) => {
    const level = levels.find((l) => l.menu.contains(document.activeElement)) ?? levels.at(-1)!;
    const depth = levels.indexOf(level);
    const list = level.buttons.filter((b) => !b.disabled);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || (event.key === "ArrowLeft" && depth > 0)) {
      event.preventDefault();
      if (depth > 0) {
        const opener = level.opener;
        closeFrom(depth);
        opener?.removeAttribute("aria-expanded");
        opener?.focus();
      } else {
        close();
        previous?.focus();
      }
    } else if (event.key === "ArrowRight" && (document.activeElement as HTMLElement)?.classList.contains("has-submenu")) {
      event.preventDefault();
      (document.activeElement as HTMLButtonElement).click();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list.at(-1))?.focus();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };
  const onPointer = (event: Event) => {
    if (!levels.some((l) => l.menu.contains(event.target as Node))) close();
  };
  function close(): void {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
    closeFrom(0);
    if (open?.close === close) open = null;
  }
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("blur", close);
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  open = { close };
}
