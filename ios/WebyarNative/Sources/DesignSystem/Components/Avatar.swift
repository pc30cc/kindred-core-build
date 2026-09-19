import SwiftUI

/// A contact or visitor avatar, matching the web inbox exactly.
///
/// The fallback order is the one `src/components/inbox/ContactAvatar.tsx`
/// uses, and it matters: an uploaded picture wins; failing that, a visitor we
/// know the operating system of gets that brand mark on its brand gradient;
/// only a visitor we know nothing about falls back to initials. That is what
/// makes a row recognisable at a glance — an anonymous Windows visitor looks
/// like a Windows visitor rather than like the letter "V".
///
/// A country flag rides in the bottom-leading corner when the IP resolved to
/// one, so an operator can see where a thread is coming from without opening
/// it.
struct Avatar: View {
    let name: String
    let imageURL: String?
    var size: CGFloat = Theme.Size.avatarMedium

    /// Visitor operating system, e.g. "Windows", "macOS", "Android".
    var os: String?
    /// Visitor device class — "desktop", "mobile", "tablet".
    var device: String?
    /// ISO-3166 alpha-2 country code; anything else is ignored.
    var countryCode: String?

    private var osKind: OSKind? {
        // An uploaded picture always wins, so the OS is not even resolved.
        imageURL == nil ? OSKind.resolve(os: os, device: device) : nil
    }

    private var initials: String {
        let source = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty else { return "?" }

        let parts = source.split(separator: " ", omittingEmptySubsequences: true)
        if parts.count >= 2, let a = parts[0].first, let b = parts[1].first {
            return String([a, b]).uppercased()
        }
        // A single word gives up its first two characters, the way the web does.
        guard let first = parts.first else { return "?" }
        if first.count >= 2 {
            return String(first.prefix(2)).uppercased()
        }
        return String(first.prefix(1)).uppercased()
    }

    /// The same twelve-hue family the web cycles through, chosen by the same
    /// djb2 hash of the same seed — so a given contact is the same colour in
    /// both inboxes, on every device, on every launch.
    private var initialsGradient: LinearGradient {
        let palette: [(hue: Double, saturation: Double)] = [
            (212, 92), (262, 78), (192, 78), (152, 62),
            (172, 70), (232, 88), (292, 70), (332, 78),
            (16, 86), (36, 90), (142, 64), (202, 88),
        ]
        let seed = name.lowercased()
        let index = Int(Self.djb2(seed.isEmpty ? "?" : seed) % UInt32(palette.count))
        let entry = palette[index]
        let saturation = entry.saturation / 100

        let start = Color(hue: entry.hue / 360, saturation: saturation, brightness: 0.56)
        let end = Color(hue: ((entry.hue + 28).truncatingRemainder(dividingBy: 360)) / 360,
                        saturation: saturation, brightness: 0.44)
        return LinearGradient(colors: [start, end], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// Swift's own `hashValue` is seeded per process, so it would give a
    /// different colour on every launch. djb2 is stable and is what the web
    /// already uses.
    private static func djb2(_ string: String) -> UInt32 {
        var hash: UInt32 = 5381
        for scalar in string.unicodeScalars {
            hash = ((hash &<< 5) &+ hash) ^ (scalar.value & 0xFFFF)
        }
        return hash
    }

    /// ISO alpha-2 → regional-indicator emoji, or nil for anything malformed.
    private var flag: String? {
        let code = (countryCode ?? "").trimmingCharacters(in: .whitespaces).uppercased()
        guard code.count == 2, code.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
        var scalars = String.UnicodeScalarView()
        for character in code.unicodeScalars {
            guard let scalar = Unicode.Scalar(0x1F1E6 + character.value - 65) else { return nil }
            scalars.append(scalar)
        }
        return String(scalars)
    }

    private var flagSize: CGFloat { max(12, size * 0.38) }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            face
                .frame(width: size, height: size)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.Palette.separator.opacity(0.5), lineWidth: 0.5))

            if let flag {
                Text(flag)
                    .font(.system(size: flagSize * 0.78))
                    .frame(width: flagSize, height: flagSize)
                    .background(Circle().fill(Theme.Palette.surface))
                    .overlay(Circle().strokeBorder(Theme.Palette.separator.opacity(0.7), lineWidth: 0.5))
                    // Flags are emoji: they must not mirror under RTL.
                    .environment(\.layoutDirection, .leftToRight)
                    .offset(x: -flagSize * 0.25, y: flagSize * 0.25)
            }
        }
        // The badge overhangs the circle, so the frame has to allow for it or
        // the row would clip a third of the flag away.
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The picture, or a skeleton, or the fallback — one of the three, never
    /// two at once.
    ///
    /// This used to draw the initials while the picture loaded, which meant
    /// every face in a scrolling list showed a letter and then swapped it for
    /// a photograph. Initials are not a loading state: they look like the
    /// answer, so the swap reads as the row changing its mind. A skeleton says
    /// "something is coming" and is replaced by the thing that came.
    ///
    /// `RemoteImage` also means a face is fetched once rather than once per
    /// appearance, so a row scrolled back to is already finished — no
    /// skeleton, no flash.
    @ViewBuilder
    private var face: some View {
        if let imageURL, let url = URL(string: imageURL) {
            RemoteImage(url: url) { fallback }
        } else {
            fallback
        }
    }

    @ViewBuilder
    private var fallback: some View {
        if let osKind {
            ZStack {
                osKind.gradient
                // The same soft top-light the web applies, which is what stops
                // the mark looking flat against a solid fill.
                LinearGradient(
                    colors: [.white.opacity(0.28), .clear],
                    startPoint: .top,
                    endPoint: .center
                )
                OSGlyph(kind: osKind, size: size * 0.5)
                    .shadow(color: .black.opacity(0.35), radius: 1, x: 0, y: 1)
            }
        } else {
            ZStack {
                initialsGradient
                Text(initials)
                    .font(.system(size: size * 0.38, weight: .semibold))
                    .foregroundStyle(.white)
                    // Initials are Latin-derived; forcing LTR keeps a mixed
                    // name from rendering its letters in the wrong order.
                    .environment(\.layoutDirection, .leftToRight)
            }
        }
    }
}
