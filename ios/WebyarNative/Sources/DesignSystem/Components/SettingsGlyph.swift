import SwiftUI

/// The small coloured tile at the head of a settings row.
///
/// A settings list is a wall of words in identical rows, and a plain SF
/// Symbol in the accent colour does very little to break it up: every glyph
/// is the same weight, the same size and the same blue, so the eye has to
/// read every row to find the one it wants. A filled tile gives each row a
/// shape and a colour the eye can aim at, which is why every first-party
/// settings screen on this platform has had one for a decade.
///
/// The colour is meaning, not decoration. Red is the row that ends something,
/// green the row that says you are reachable, blue the ordinary ones.
struct SettingsGlyph: View {
    let systemImage: String
    var tint: Color = Theme.Palette.brand

    /// 29 points is the tile Settings.app draws, and the size that leaves a
    /// standard row exactly as tall as it was before the tile arrived.
    private static let side: CGFloat = 29

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            // Symbols have very different ink; centring them in a fixed box
            // is what keeps a row of tiles looking like one row.
            .frame(width: Self.side, height: Self.side)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(tint.gradient)
            )
            // The tile is decoration for the words beside it; a screen reader
            // that announced "bell badge" before every row would be reading
            // out the furniture.
            .accessibilityHidden(true)
    }
}

/// A settings row: tile, title, and an optional trailing note.
struct SettingsRowLabel: View {
    let title: String
    let systemImage: String
    var tint: Color = Theme.Palette.brand
    /// Colours the words as well as the tile — for the one row that signs you
    /// out, where the tile alone is not warning enough.
    var isDestructive = false

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            SettingsGlyph(systemImage: systemImage, tint: tint)
            Text(title)
                .foregroundStyle(isDestructive ? Theme.Palette.danger : Theme.Palette.label)
        }
    }
}
