import SwiftUI

/// A contact, visitor, colleague or workspace picture.
///
/// An uploaded picture wins. Failing that, a visitor we know the operating
/// system of gets that brand mark on its brand gradient, as the web inbox
/// draws it (`src/components/inbox/ContactAvatar.tsx`) — an anonymous
/// Windows visitor looks like a Windows visitor. Everyone else gets the
/// skeleton's silhouette (`AvatarSkeleton`), never initials: the same shape
/// that stands in while a picture loads, so there is one placeholder in the
/// app and it never pretends to be somebody.
///
/// A country flag rides in the bottom-leading corner when the IP resolved to
/// one, so an operator can see where a thread is coming from without opening
/// it.
struct Avatar: View {
    let name: String
    let imageURL: String?
    var size: CGFloat = Theme.Size.avatarMedium
    /// A person, or a workspace's logo — which decides the silhouette.
    var subject: AvatarSkeleton.Subject = .person

    /// Something is being done to this picture right now — a new one being
    /// uploaded, the current one being removed.
    ///
    /// It draws the skeleton in place of the face, which is the same thing
    /// the app already shows for a picture that has not arrived yet. The
    /// alternative, and what Settings used to do, is to lay a dimming circle
    /// and a spinner OVER the avatar: three views stacked in one slot, the
    /// operator's own face dimly visible behind a scrim, and a loading
    /// vocabulary that appears nowhere else in the app. One layer, one
    /// vocabulary.
    var isBusy: Bool = false

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

    /// The picture, or the silhouette sweeping while it loads, or the
    /// fallback — one of the three, never two at once.
    ///
    /// `RemoteImage` means a face is fetched once rather than once per
    /// appearance, so a row scrolled back to is already finished — no
    /// skeleton, no flash — and a face arriving for the first time fades in
    /// over its silhouette rather than cutting in.
    @ViewBuilder
    private var face: some View {
        if isBusy {
            AvatarSkeleton(subject: subject, isLoading: true)
        } else if let imageURL, let url = URL(string: imageURL) {
            RemoteImage(url: url, maxPixel: pixels) {
                AvatarSkeleton(subject: subject, isLoading: true)
            } fallback: {
                fallback
            }
        } else {
            fallback
        }
    }

    /// How large to decode this picture, from how large it will be drawn.
    ///
    /// `RemoteImage`'s own default is 256, which its note says suits an
    /// avatar — and it does, for the 32-to-76 point ones in a list. The call
    /// screen draws a face at 140 points, which is 420 pixels on a 3× screen,
    /// so that default was handing it a 256-pixel image to stretch: the one
    /// avatar in the app big enough to look at was the blurry one. Deriving
    /// it here means every caller gets the right size without having to know
    /// that it is a question, and the cache keys on the size, so the same
    /// face at two sizes is two entries rather than one wrong one.
    private var pixels: Int { Int((size * 3).rounded(.up)) }

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
            AvatarSkeleton(subject: subject)
        }
    }
}
