import SwiftUI

/// The product's name, set as a wordmark.
///
/// This replaces a rounded square containing the first letter — "W", or "و".
/// A single letter in a box is what an app uses when it has no mark yet, and
/// it said nothing about the product to somebody opening it for the first
/// time. The name says it.
///
/// Latin and Persian are set differently on purpose, because they are
/// different writing systems rather than the same one in two alphabets:
///
///   • WEBYAR is capitalised and letter-spaced, which is how a Latin wordmark
///     is drawn and the only way tracking is ever used.
///   • وب‌یار is NOT tracked. Persian is a connected script, and adding
///     tracking to it pulls the joins apart — the letters stop touching and
///     the word stops being a word. Its width comes from kashida inside the
///     string instead, which is the typographically correct way to stretch
///     Persian, and the form the brand already uses.
struct BrandWordmark: View {
    let language: Language
    var size: CGFloat = 34
    /// Whether the mark carries the loading sweep. Off wherever it is just a
    /// logo — a login screen is not loading anything.
    var isLoading = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -0.4
    @State private var hasAppeared = false

    private var text: String { Str.brandWordmark(language) }

    /// Persian gets none; see the note above.
    private var tracking: CGFloat { language == .fa ? 0 : size * 0.16 }

    /// Rounded for Latin — it is the shape of the brand and of the rest of
    /// this app's display type. Persian is left to the system's Persian face,
    /// which has no rounded cut and would fall back to something else.
    private var font: Font {
        language == .fa
            ? .system(size: size, weight: .bold)
            : .system(size: size, weight: .heavy, design: .rounded)
    }

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
        Text(text)
            .font(font)
            .tracking(tracking)
            .foregroundStyle(color)
            // Tracking adds its space after the last glyph too, which shifts
            // a centred wordmark half a letter off-centre.
            .padding(.trailing, tracking)
    }

    /// A band of light travelling across the word.
    ///
    /// Built from gradient stops rather than an offset rectangle so it
    /// mirrors itself under right-to-left: `.leading` and `.trailing` already
    /// mean the right thing in both directions, where an x-offset would need
    /// its sign flipped by hand and would be wrong in Persian.
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
