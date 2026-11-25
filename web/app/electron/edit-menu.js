// The right-click menu of a text box (owner, 2026-11-20, for the lyrics editor): spelling suggestions for the misspelled word under the
// pointer, "Add to dictionary", then the usual undo/cut/copy/paste. The app has no menu bar, so this is the only place they live.
// `template` is pure (it only reads the facts Electron gives about the click), so it is unit tested; `attach` wires it to a window.

const MAX_SUGGESTIONS = 6;

/** The menu items for a click in an editable text box; `actions` supplies what the spelling items do. */
function template(params, actions) {
  const items = [];
  const word = typeof params.misspelledWord === "string" ? params.misspelledWord : "";
  if (word) {
    const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS) : [];
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => actions.replace(suggestion) });
    }
    if (suggestions.length === 0) items.push({ label: "No spelling suggestions", enabled: false });
    items.push({ type: "separator" }, { label: `Add “${word}” to the dictionary`, click: () => actions.addToDictionary(word) }, { type: "separator" });
  }
  const edit = params.editFlags ?? {};
  items.push(
    { role: "undo", enabled: edit.canUndo !== false },
    { role: "redo", enabled: edit.canRedo !== false },
    { type: "separator" },
    { role: "cut", enabled: edit.canCut !== false },
    { role: "copy", enabled: edit.canCopy !== false },
    { role: "paste", enabled: edit.canPaste !== false },
    { type: "separator" },
    { role: "selectAll" },
  );
  return items;
}

/** Shows the menu on right-click in an editable box (nowhere else: the page has its own menus). */
function attach(window, { Menu }) {
  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    const contents = window.webContents;
    const menu = Menu.buildFromTemplate(
      template(params, {
        replace: (word) => contents.replaceMisspelling(word),
        addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      }),
    );
    menu.popup({ window });
  });
}

module.exports = { template, attach };
