// A tiny helper shared by the pages: make an element with an optional class and text.
// Text is always set with textContent, so nothing from the sidecar or services is read as HTML.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
