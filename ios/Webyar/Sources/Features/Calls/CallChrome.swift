import SwiftUI

// The call screens' shared look (owner, 2026-11-04: "during a call the call
// view must not be transparent", "the incoming call screen much better and
// more beautiful"): one backdrop, one pulse, one pill, used by the colleague
// call (`TeamCallScreen`, `TeamCallBubble`), the visitor call (`CallScreen`)
// and the PiP window's face (`CallPiPFace`).
//
// Brand-neutral: the tint is the build's own brand kit (`BrandPalette`,
// WebYar's or RESPOK's), never a colour written here.

/// Behind every call screen: fully opaque, whatever is under it.
///
/// Black first — the layer that makes it opaque, so neither the app's own
/// window under the colleague call's window nor the conversation under a
/// visitor call's cover can show through — then the brand's deep tone from
/// the top, the caller's photo blurred and darkened when there is one, a
/// soft glow where the face sits, and a darker foot for the controls.
struct CallBackdrop: View {
    var photoURL: String?

    var body: some View {
        ZStack {
            Color.black

            LinearGradient(
                stops: [
                    .init(color: BrandPalette.deep.opacity(0.85), location: 0),
                    .init(color: BrandPalette.deep.opacity(0.35), location: 0.5),
                    .init(color: BrandPalette.deep.opacity(0.08), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            if let url = photoURL.flatMap(URL.init(string:)) {
                Color.clear
                    .overlay {
                        RemoteImage(url: url, maxPixel: 160, placeholder: { Color.clear }, fallback: { Color.clear })
                            .blur(radius: 50, opaque: true)
                            .opacity(0.4)
                    }
                    .clipped()
            }

            RadialGradient(
                colors: [BrandPalette.bright.opacity(0.20), .clear],
                center: UnitPoint(x: 0.5, y: 0.4),
                startRadius: 10,
                endRadius: 340
            )

            LinearGradient(
                colors: [.clear, .black.opacity(0.65)],
                startPoint: UnitPoint(x: 0.5, y: 0.55),
                endPoint: .bottom
            )
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A face, with soft rings flowing out of it while the call rings — the
/// visual ring tone. Still rings under Reduce Motion.
struct CallHalo<Face: View>: View {
    let diameter: CGFloat
    let ringing: Bool
    @ViewBuilder let face: Face

    var body: some View {
        face
            .frame(width: diameter, height: diameter)
            .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1))
            .shadow(color: .black.opacity(0.45), radius: 30, y: 14)
            .background {
                if ringing {
                    CallPulse(diameter: diameter)
                        .transition(.opacity)
                } else {
                    Circle()
                        .fill(BrandPalette.bright.opacity(0.12))
                        .frame(width: diameter + 28, height: diameter + 28)
                        .blur(radius: 12)
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.4), value: ringing)
            .accessibilityHidden(true)
    }
}

/// Three rings leaving the face one after the other, every 2.4 s.
struct CallPulse: View {
    let diameter: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                Circle()
                    .strokeBorder(.white.opacity(0.3), lineWidth: 2)
                    .frame(width: diameter + 24, height: diameter + 24)
            } else {
                TimelineView(.animation) { context in
                    let time = context.date.timeIntervalSinceReferenceDate
                    ZStack {
                        ForEach(0..<3, id: \.self) { ring in
                            let progress = (time / 2.4 + Double(ring) / 3).truncatingRemainder(dividingBy: 1)
                            Circle()
                                .fill(BrandPalette.bright.opacity(0.16 * (1 - progress)))
                                .overlay(Circle().strokeBorder(.white.opacity(0.32 * (1 - progress)), lineWidth: 1.5))
                                .frame(width: diameter, height: diameter)
                                .scaleEffect(1 + progress * 0.75)
                        }
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A short line in a capsule: the kind of call, or its clock.
struct CallPill: View {
    let text: String
    var icon: String?

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            if let icon {
                Image(systemName: icon)
                    .imageScale(.small)
            }
            Text(text)
                .lineLimit(1)
        }
        .font(.app(.footnote, .medium))
        .foregroundStyle(.white.opacity(0.9))
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.xs + 2)
        .background(Capsule().fill(.white.opacity(0.12)))
        .overlay(Capsule().strokeBorder(.white.opacity(0.10), lineWidth: 1))
    }
}

/// The row of controls on a call, on a rounded tray of its own.
struct CallControlTray<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, Theme.Space.md)
            .padding(.top, Theme.Space.lg)
            .padding(.bottom, Theme.Space.md)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .fill(.white.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .strokeBorder(.white.opacity(0.08), lineWidth: 1)
            )
    }
}

/// The top bar's small round button (minimise the call).
struct CallCornerButton: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
                .background(Circle().fill(.white.opacity(0.14)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
