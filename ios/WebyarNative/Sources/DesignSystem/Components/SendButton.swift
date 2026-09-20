import SwiftUI

/// The one send button in the app.
///
/// There were four, and no two were alike: the chat composer's was 34pt with
/// a 17pt bold arrow, the voice-note bar's 38pt with a 16pt semibold one, the
/// internal-note sheet's 34pt with 16pt, and the mail composer's 34pt with
/// 15pt. Three of them showed nothing while the send was in flight. An
/// operator moving between an email and a chat saw the same control change
/// size and weight under their thumb.
///
/// One size, one weight, one disabled treatment, one busy treatment.
///
/// The three states are deliberately distinguishable without colour, because
/// the disabled and enabled fills differ only in opacity: the glyph swaps to
/// a spinner while sending, and the button stops taking taps in both of the
/// other two — so nothing here depends on telling two blues apart.
struct SendButton: View {
    /// Whether there is anything to send. Drives the fill and the tap.
    let isEnabled: Bool
    /// Whether a send is already in flight.
    var isSending: Bool = false
    /// What this button sends, spoken. Never drawn — the glyph is an arrow
    /// everywhere, so this is the only thing that says what it does.
    let label: String
    let action: () -> Void

    /// Matches the other controls that sit inside a composer pill, so the
    /// row's height is set by the pill rather than by whichever control is
    /// tallest today.
    private static let diameter: CGFloat = 34
    /// The box this button occupies in the row, and the box every other
    /// composer control occupies. The two differ so the circle has a point
    /// of air around it inside a box that still lines up with its neighbours.
    private static let box: CGFloat = ComposerGlyph.box

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Theme.Palette.brand.opacity(isEnabled && !isSending ? 1 : 0.35))

                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: Self.diameter, height: Self.diameter)
            .frame(width: Self.box, height: Self.box)
            // The tap target is Apple's 44, but it is given to the hit test
            // only. Laying it out at 44 made this the tallest thing in the
            // pill: the row bottom-aligns, so the arrow sat four points above
            // the glyphs beside it and the pill grew to hold a box nobody
            // could see. Pad out, take the hit test at the padded size, hand
            // the padding back to the layout.
            .padding((Theme.Size.minTouchTarget - Self.box) / 2)
            .contentShape(Rectangle())
            .padding(-(Theme.Size.minTouchTarget - Self.box) / 2)
        }
        .buttonStyle(SendButtonStyle())
        .disabled(!isEnabled || isSending)
        .accessibilityLabel(label)
        .accessibilityIdentifier(A11y.composerSend)
        .animation(Theme.Motion.standard, value: isEnabled)
        .animation(Theme.Motion.standard, value: isSending)
    }
}

/// Press feedback, and nothing else.
///
/// `.plain` leaves a send button completely inert under the thumb, which on
/// iOS reads as a tap that did not land — the reason people tap twice and
/// send twice. A small scale is what the system's own filled buttons do.
private struct SendButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.88 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
