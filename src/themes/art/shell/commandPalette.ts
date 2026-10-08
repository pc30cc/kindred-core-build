/** Opens the command palette, as ⌘K / Ctrl+K does (see CommandPalette.tsx). */
export function openCommandPalette() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
}

/** The palette's shortcut as this device writes it: ⌘K on Apple's, Ctrl K elsewhere. */
export function commandPaletteShortcut() {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘K' : 'Ctrl K';
}
