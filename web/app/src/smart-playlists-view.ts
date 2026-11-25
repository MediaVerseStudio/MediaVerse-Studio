// The smart playlist pane of Library > Playlists: the rules (as sentences), the order and the limit, and the songs they give right now. Worked out each time it
// is opened, so it is always up to date. All text is set with textContent.

import { el } from "./dom";
import { formatLength, formatTotal, plural, totalLength } from "./library-format";
import type { LibraryTrack } from "./library-view";
import { FIELDS, OPERATORS, evaluate, type Field, type Rule, type Smart, type Sort } from "./smart-playlists";
import { readFacts, type SmartStore } from "./smart-store";

export type SmartPaneDeps = {
  songs: () => LibraryTrack[];
  store: SmartStore;
  play: (queue: LibraryTrack[], index: number) => void;
  enqueue: (songs: LibraryTrack[], where: "next" | "end") => void;
  /** Makes an ordinary playlist from these songs (asks for the name). */
  saveAsPlaylist: (songs: LibraryTrack[]) => void;
  /** Redraws the whole view (after the list of smart playlists changed). */
  refresh: () => void;
};

const SORTS: { value: Sort; label: string }[] = [
  { value: "random", label: "in a random order" },
  { value: "title", label: "by title" },
  { value: "artist", label: "by artist and album" },
  { value: "newest", label: "newest first" },
  { value: "most_played", label: "most played first" },
  { value: "year", label: "oldest first" },
];

export function buildSmartPane(smart: Smart, deps: SmartPaneDeps): HTMLElement {
  const pane = el("div", "smart-pane");
  const draft: Smart = { ...smart, rules: smart.rules.map((r) => ({ ...r })) };
  const results = el("div", "smart-results");
  let found: LibraryTrack[] = [];

  const head = el("div", "pl-head");
  const name = el("input", "smart-name");
  name.type = "text";
  name.value = draft.name;
  name.setAttribute("aria-label", "Name of the smart playlist");
  name.addEventListener("change", () => {
    draft.name = name.value.trim() || "Smart playlist";
    save();
  });
  const remove = el("button", "secondary", "Delete");
  remove.type = "button";
  remove.addEventListener("click", () => {
    deps.store.remove(draft.id);
    deps.refresh();
  });
  head.append(name, remove);

  const rules = el("div", "smart-rules");
  const matchRow = el("p", "smart-sentence");
  const match = el("select");
  for (const [value, label] of [["all", "all"], ["any", "any"]] as const) match.append(new Option(label, value, false, draft.match === value));
  match.setAttribute("aria-label", "Match all or any rule");
  match.addEventListener("change", () => {
    draft.match = match.value === "any" ? "any" : "all";
    save();
  });
  matchRow.append("Songs that match ", match, " of these rules:");

  function ruleRow(rule: Rule, index: number): HTMLElement {
    const row = el("div", "smart-rule");
    const field = el("select");
    for (const f of FIELDS) field.append(new Option(f.label, f.field, false, f.field === rule.field));
    const op = el("select");
    const value = el("input");
    value.type = "text";
    const heart = el("select");
    heart.append(new Option("yes", "yes"), new Option("no", "no"));
    const fill = (): void => {
      const kind = FIELDS.find((f) => f.field === rule.field)?.kind ?? "text";
      op.replaceChildren(...OPERATORS[kind].map((o) => new Option(o.label, o.op, false, o.op === rule.op)));
      if (!OPERATORS[kind].some((o) => o.op === rule.op)) rule.op = OPERATORS[kind][0]!.op;
      value.hidden = kind === "heart";
      heart.hidden = kind !== "heart";
      value.type = kind === "number" ? "number" : "text";
      value.value = rule.value;
      heart.value = rule.value === "no" ? "no" : "yes";
      if (kind === "heart" && !rule.value) rule.value = "yes";
    };
    field.addEventListener("change", () => {
      rule.field = field.value as Field;
      rule.value = "";
      fill();
      save();
    });
    op.addEventListener("change", () => {
      rule.op = op.value as Rule["op"];
      save();
    });
    value.addEventListener("input", () => {
      rule.value = value.value;
    });
    value.addEventListener("change", save);
    heart.addEventListener("change", () => {
      rule.value = heart.value;
      save();
    });
    const drop = el("button", "icon-button", "×");
    drop.type = "button";
    drop.setAttribute("aria-label", "Remove this rule");
    drop.addEventListener("click", () => {
      draft.rules.splice(index, 1);
      drawRules();
      save();
    });
    field.setAttribute("aria-label", "Rule: what to look at");
    op.setAttribute("aria-label", "Rule: how to compare");
    value.setAttribute("aria-label", "Rule: the value");
    fill();
    row.append(field, op, value, heart, drop);
    return row;
  }

  function drawRules(): void {
    rules.replaceChildren(...draft.rules.map(ruleRow));
    const add = el("button", "secondary", "Add a rule");
    add.type = "button";
    add.addEventListener("click", () => {
      draft.rules.push({ field: "genre", op: "contains", value: "" });
      drawRules();
    });
    rules.append(add);
  }
  drawRules();

  const order = el("p", "smart-sentence");
  const sort = el("select");
  for (const s of SORTS) sort.append(new Option(s.label, s.value, false, s.value === draft.sort));
  sort.setAttribute("aria-label", "Order");
  sort.addEventListener("change", () => {
    draft.sort = sort.value as Sort;
    save();
  });
  const limit = el("input");
  limit.type = "number";
  limit.min = "0";
  limit.max = "5000";
  limit.value = draft.limit ? String(draft.limit) : "";
  limit.placeholder = "no limit";
  limit.setAttribute("aria-label", "Most songs (empty for no limit)");
  limit.addEventListener("change", () => {
    draft.limit = Number(limit.value) > 0 ? Math.floor(Number(limit.value)) : null;
    save();
  });
  order.append("Put them ", sort, ", at most ", limit, " songs.");

  const buttons = el("div", "settings-actions");
  const play = el("button", undefined, "Play");
  const mix = el("button", "secondary", "Shuffle");
  const queue = el("button", "secondary", "Add to queue");
  const keep = el("button", "secondary", "Save as a playlist…");
  for (const b of [play, mix, queue, keep]) b.type = "button";
  play.addEventListener("click", () => found.length && deps.play(found, 0));
  mix.addEventListener("click", () => {
    const mixed = [...found].sort(() => Math.random() - 0.5);
    if (mixed.length) deps.play(mixed, 0);
  });
  queue.addEventListener("click", () => found.length && deps.enqueue(found, "end"));
  keep.addEventListener("click", () => found.length && deps.saveAsPlaylist(found));
  buttons.append(play, mix, queue, keep);

  const summary = el("p", "field-hint");

  function save(): void {
    deps.store.save(draft);
    void refreshResults();
  }

  async function refreshResults(): Promise<void> {
    summary.textContent = "Working it out…";
    const facts = await readFacts();
    found = evaluate(draft, deps.songs(), facts) as LibraryTrack[];
    summary.textContent = `${plural(found.length, "song")}${found.length ? ` · ${formatTotal(totalLength(found))}` : ""}. The list is worked out each time you open it, so it is always up to date.`;
    const table = el("table", "lib-table pl-table");
    const body = el("tbody");
    for (const [i, song] of found.slice(0, 300).entries()) {
      const row = el("tr", "lib-row pl-row");
      row.append(el("td", "is-number", String(i + 1)), el("td", undefined, song.title), el("td", "is-number", formatLength(song.length_ms)), el("td", undefined, song.artist ?? ""), el("td", undefined, song.album ?? ""));
      row.addEventListener("dblclick", () => deps.play(found, i));
      body.append(row);
    }
    table.append(body);
    results.replaceChildren(table);
    if (found.length > 300) results.append(el("p", "field-hint", `${found.length - 300} more are not listed here (they all play).`));
  }

  pane.append(head, matchRow, rules, order, buttons, summary, results);
  void refreshResults();
  return pane;
}
