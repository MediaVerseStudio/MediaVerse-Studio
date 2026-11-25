// The naming rules and the other choices of Settings > Organise, kept apart from the page so they can be tested.

export const DEFAULT_RULE = "{albumartist}/{album}/{disc}{track} - {title}";

/// The most common ways to name and place a library (the first is the default). {disc} is only filled for disc 2 and up.
export const RULES: { id: string; label: string; rule: string }[] = [
  { id: "dash", label: "Artist / Album / 01 - Title", rule: DEFAULT_RULE },
  { id: "space", label: "Artist / Album / 01 Title", rule: "{albumartist}/{album}/{disc}{track} {title}" },
  { id: "dot", label: "Artist / Album / 01. Title", rule: "{albumartist}/{album}/{disc}{track}. {title}" },
  { id: "year-after", label: "Artist / Album (Year) / 01 - Title", rule: "{albumartist}/{album} ({year})/{disc}{track} - {title}" },
  { id: "year-before", label: "Artist / Year - Album / 01 - Title", rule: "{albumartist}/{year} - {album}/{disc}{track} - {title}" },
  { id: "folders", label: "Keep each file's own name, fix only the folders (Artist / Album)", rule: "{albumartist}/{album}/{file}" },
];

export type Choices = { rule: string; custom: string; compilations: boolean };
export const CHOICES_KEY = "mediaverse.organise.v1";

export function readChoices(storage: Pick<Storage, "getItem"> = window.localStorage): Choices {
  const base: Choices = { rule: "dash", custom: DEFAULT_RULE, compilations: true };
  try {
    const v = JSON.parse(storage.getItem(CHOICES_KEY) ?? "null") as Partial<Choices> | null;
    if (!v || typeof v !== "object") return base;
    return {
      rule: v.rule === "custom" || RULES.some((r) => r.id === v.rule) ? (v.rule as string) : base.rule,
      custom: typeof v.custom === "string" && v.custom.trim() && v.custom.length < 200 ? v.custom : base.custom,
      compilations: v.compilations !== false,
    };
  } catch {
    return base;
  }
}

/// The naming rule these choices mean.
export const ruleOf = (c: Choices): string => (c.rule === "custom" ? c.custom.trim() || DEFAULT_RULE : (RULES.find((r) => r.id === c.rule)?.rule ?? DEFAULT_RULE));

