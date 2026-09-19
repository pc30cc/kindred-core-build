import SwiftUI

/// A promotional strip at the top of the inbox.
///
/// It is drawn as one of our own cards — brand tint, our type, our corner
/// radius — and never as anything that could be mistaken for an alert, a
/// notification or an iOS control. Guideline 2.3.1 is explicit about that, and
/// it is also simply how an operator tool should behave.
struct PromoBanner: View {
    let creative: PromoCreative
    let language: Language
    let onDismiss: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            Image(systemName: "sparkles")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Palette.brand)
                .frame(width: 32, height: 32)
                .background(Circle().fill(Theme.Palette.brand.opacity(0.12)))

            VStack(alignment: .leading, spacing: 2) {
                Text(creative.title)
                    .font(Theme.Typo.rowTitle)
                    .foregroundStyle(Theme.Palette.label)

                if !creative.body.isEmpty {
                    Text(creative.body)
                        .font(Theme.Typo.rowSubtitle)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let link = creative.link, let label = creative.ctaLabel {
                    Button(label) { openURL(link) }
                        .font(Theme.Typo.metaEmphasis)
                        .foregroundStyle(Theme.Palette.brand)
                        .padding(.top, 2)
                }
            }

            Spacer(minLength: 0)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    // Small mark, full-size target: Apple asks for 44 points
                    // and a close control people miss is worse than none.
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Str.close(language))
        }
        .padding(.vertical, Theme.Space.sm)
        .padding(.horizontal, Theme.Space.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Palette.brand.opacity(0.07))
        )
        .accessibilityElement(children: .contain)
    }
}

/// The full-screen promotion.
///
/// Everything Apple asks of an interstitial is structural here rather than
/// optional: the close button is drawn before anything else, it is 44 points,
/// it is never delayed behind a countdown, and the card has nothing that
/// imitates a system surface. It is also never shown over a call or a
/// conversation — only the inbox offers one.
struct PromoFullScreen: View {
    let creative: PromoCreative
    let language: Language
    let onDismiss: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Theme.Palette.background.ignoresSafeArea()

            VStack(spacing: Theme.Space.xl) {
                Spacer(minLength: 0)

                if let imageURL = creative.imageURL, let url = URL(string: imageURL) {
                    AsyncImage(url: url) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        Color.clear
                    }
                    .frame(maxWidth: 260, maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
                } else {
                    BrandMark(size: 72)
                }

                VStack(spacing: Theme.Space.sm) {
                    Text(creative.title)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.Palette.label)
                        .multilineTextAlignment(.center)

                    if !creative.body.isEmpty {
                        Text(creative.body)
                            .font(.body)
                            .foregroundStyle(Theme.Palette.labelSecondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 320)
                    }
                }

                Spacer(minLength: 0)

                VStack(spacing: Theme.Space.sm) {
                    if let link = creative.link, let label = creative.ctaLabel {
                        Button {
                            openURL(link)
                            onDismiss()
                        } label: {
                            Text(label)
                                .font(Theme.Typo.button)
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(
                                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                                        .fill(Theme.Palette.brand)
                                )
                        }
                        .buttonStyle(.plain)
                    }

                    // A second way out, in words, under the button. The X is
                    // the requirement; this is the one people actually look
                    // for when the card fills the screen.
                    Button(Str.notNow(language)) { onDismiss() }
                        .font(Theme.Typo.button)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .padding(.horizontal, Theme.screenInset)
                .padding(.bottom, Theme.Space.xl)
            }
            .padding(.horizontal, Theme.screenInset)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Theme.Palette.surfaceElevated))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .padding(Theme.Space.md)
            .accessibilityLabel(Str.close(language))
        }
    }
}
