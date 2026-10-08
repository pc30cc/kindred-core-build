/** Opens the command palette, as ⌘K / Ctrl+K does (see CommandPalette.tsx). */
export function openCommandPalette() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
}
