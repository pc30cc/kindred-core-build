import SwiftUI

/// The product's name, set as a wordmark.
///
/// This replaces a rounded square containing the first letter — "W", or "و".
/// A single letter in a box is what an app uses when it has no mark yet, and
/// it said nothing about the product to somebody opening it for the first
/// time. The name says it.
///
/// It is WEBYAR in every language, including Persian. The app's *prose* name
/// is translated — `Str.appName` gives "وب‌یار" inside a Persian sentence,
/// and it should — but a wordmark is not prose. It is the same mark that is
/// on the icon, the website, the invoice and the App Store listing, and
/// setting it in a different script depending on who opened the app makes it
/// look like a different product. So the mark does not translate.
///
/// Latin, therefore, and drawn the way a Latin wordmark is drawn: capitalised
/// and letter-spaced. (The Persian setting this used to carry was kashida
/// rather than tracking, which was the right call for the wrong question —
/// the script is connected and tracking pulls its joins apart. It is gone
/// with the Persian mark.)
struct BrandWordmark: View {
    /// Only for what VoiceOver says. The glyphs are the same either way.
    let language: Language
    var size: CGFloat = 34
    /// Whether the mark carries the loading sweep. Off wherever it is just a
    /// logo — a login screen is not loading anything.
    var isLoading = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -0.4
    @State private var hasAppeared = false

    private var tracking: CGFloat { size * 0.16 }

    /// Rounded: it is the shape of the brand and of the rest of this app's
    /// display type.
    private var font: Font { .system(size: size, weight: .heavy, design: .rounded) }

    var body: some View {
        // The resting mark is legible on its own — a wordmark that all but
        // disappears between sweeps reads as a rendering fault rather than as
        // loading. The sweep lifts it the rest of the way rather than being
        // the only thing that makes it visible.
        base(Theme.Palette.brand.opacity(isLoading && !reduceMotion ? 0.34 : 1))
            .overlay {
                if isLoading && !reduceMotion {
                    base(Theme.Palette.brand).mask(sweep)
                }
            }
            // Arrives rather than appears. The system's own launch image is
            // this same background with nothing on it, so without this the
            // mark cuts in from one frame to the next.
            .opacity(hasAppeared ? 1 : 0)
            .scaleEffect(hasAppeared ? 1 : 0.94)
            // The mark is Latin on a screen that may be laid out
            // right-to-left, so the whole component is pinned left-to-right:
            // the glyphs, or they are reordered and WEBYAR is drawn RAYBEW,
            // and the sweep with them, or the light travels backwards across
            // a word that reads forwards.
            .environment(\.layoutDirection, .leftToRight)
            .accessibilityElement()
            .accessibilityLabel(Str.appName(language))
            .onAppear {
                withAnimation(.easeOut(duration: 0.45)) { hasAppeared = true }
                guard isLoading, !reduceMotion else { return }
                // Slow enough to read as deliberate. At the speed a spinner
                // turns it reads as a glitch travelling across the word.
                withAnimation(.linear(duration: 2.1).repeatForever(autoreverses: false)) {
                    phase = 1.4
                }
            }
    }

    private func base(_ color: Color) -> some View {
        Text(Str.brandWordmark)
            .font(font)
            .tracking(tracking)
            .foregroundStyle(color)
            // Tracking adds its space after the last glyph too, which shifts
            // a centred wordmark half a letter off-centre.
            .padding(.trailing, tracking)
    }

    /// A band of light travelling across the word, in the direction the word
    /// is read — which is left to right, always, because the word is Latin.
    ///
    /// Built from gradient stops rather than an offset rectangle: the stops
    /// are what `phase` animates, and one animatable number is easier to keep
    /// inside 0…1 than an offset that would have to be derived from the
    /// rendered width.
    private var sweep: some View {
        LinearGradient(
            stops: [
                .init(color: .clear, location: clamp(phase - 0.42)),
                .init(color: .white, location: clamp(phase)),
                .init(color: .clear, location: clamp(phase + 0.42)),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
    }

    /// Stop locations have to stay inside 0…1 and in order, which clamping
    /// gives for free: two stops landing on the same location is a hard edge,
    /// not a crash.
    private func clamp(_ value: CGFloat) -> CGFloat { min(max(value, 0), 1) }
}
