/**
 * The two glyphs the whole product draws where there is no picture, on a
 * 24 × 24 grid, `fill="currentColor"`:
 *
 * - the person, for an operator or a teammate without a photo (never
 *   initials);
 * - the workspace's shop front, for a workspace whose owner set no logo
 *   (never its first letter).
 *
 * One design for the web panel, both website widgets and every native app.
 * This package cannot import the web's modules, so the paths are copied here
 * character for character; `src/test/native/avatarGlyphs.test.ts` holds every
 * app to the canonical strings. Both are left–right symmetric, so they never
 * mirror under right to left.
 */
export const PERSON_GLYPH =
  'M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 10.75c-4.6 0-8 2.3-8 5.25 0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2 0-2.95-3.4-5.25-8-5.25z'

export const WORKSPACE_GLYPH =
  'M6.6 3h10.8q.9 0 1.38.83L21.5 8.5A2.375 2.375 0 0 1 20.25 10.59v8.16A2.25 2.25 0 0 1 18 21H6a2.25 2.25 0 0 1-2.25-2.25v-8.16A2.375 2.375 0 0 1 2.5 8.5l2.72-4.67Q5.7 3 6.6 3zm-.85 7.71v8.04q0 .25.25.25h4v-2.75a2 2 0 0 1 4 0V19h4q.25 0 .25-.25v-8.04A2.375 2.375 0 0 1 16.75 8.5a2.375 2.375 0 0 1-4.75 0 2.375 2.375 0 0 1-4.75 0 2.375 2.375 0 0 1-1.5 2.21z'

/**
 * How much of an avatar `size` pixels across the glyph's 24-unit box takes,
 * centred: 62% for the person and 58% for the workspace, a little more on a
 * chip of 24 px or less so the figure stays legible.
 */
export function glyphBox(glyph: 'person' | 'workspace', size: number): number {
  if (glyph === 'person') return size <= 24 ? 0.68 : 0.62
  return size <= 24 ? 0.62 : 0.58
}

/** Whose face an avatar is: a visitor, a teammate (an operator, a colleague, the operator themself) or a workspace. */
export type AvatarKind = 'visitor' | 'person' | 'workspace'

/** What stands in a face's place: the picture, a visitor's letters, or one of the two glyphs. */
export type AvatarFace = 'picture' | 'letters' | 'person' | 'workspace'

/**
 * The picture when there is one. Without it, letters for a visitor only: a
 * teammate is the person glyph and a workspace the shop front, never letters
 * (the owner's rule, for every app).
 */
export function avatarFace(kind: AvatarKind, hasPicture: boolean): AvatarFace {
  if (hasPicture) return 'picture'
  return kind === 'visitor' ? 'letters' : kind
}
