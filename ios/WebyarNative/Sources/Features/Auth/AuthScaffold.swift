import SwiftUI

/// The chrome the signed-out screens share.
///
/// There are two of them now — sign in, and reset your password — and they
/// have to look like one place. Before this, the login screen carried its own
/// backdrop, its own field card and its own row geometry inline, which is
/// fine for one screen and is how the second one ends up subtly different:
/// another corner radius, another icon gutter, another idea of where a field
/// starts.

// MARK: - Backdrop

/// What both auth screens sit on.
///
/// The same colour and the same pool of brand light as `LaunchView`, anchored
/// nearer the top because that is where the form is here — the light falls on
/// what you came to use, not on the mark signed at the foot. The app opens on
/// the launch screen and then becomes this one, so the two sharing a backdrop
/// is the difference between a transition and a cut.
struct AuthBackdrop: View {
    var body: some View {
        ZStack {
            Color("LaunchBackground")

            RadialGradient(
                colors: [Theme.Palette.brand.opacity(0.13), .clear],
                center: UnitPoint(x: 0.5, y: 0.16),
                startRadius: 0,
                endRadius: 420
            )
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

// MARK: - Field card

/// One rounded container holding the fields, with a hairline and a soft lift.
///
/// The lift is what separates it from the backdrop. A flat card on a flat
/// background is two rectangles; the shadow is what makes it a card sitting on
/// a screen. Kept shallow — at this radius anything deeper reads as a popup.
struct AuthCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .fill(Theme.Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .strokeBorder(Theme.Palette.separator.opacity(0.55), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.07), radius: 18, x: 0, y: 8)
    }
}

/// The numbers a field row is built from.
///
/// Its own type rather than a static on `AuthFieldRow`, because the divider
/// between two rows needs the gutter too and `AuthFieldRow` is generic —
/// reaching a static through it means naming both placeholders at the call
/// site, which says nothing and breaks the moment a row gains an accessory.
enum AuthField {
    /// The icon column. Fixed rather than sized to the glyph, which is the
    /// whole point: it is what keeps every field's text starting on exactly
    /// the same vertical line, on both screens, whichever icon a row carries.
    static let gutter: CGFloat = Theme.Space.huge + Theme.Space.xs
}

/// One field row: a fixed-width icon gutter, the control, and an optional
/// trailing accessory.
///
/// The gutter is fixed rather than sized to the glyph, and that is the whole
/// point of it: it is what keeps every field's text starting on exactly the
/// same vertical line, on both screens, whichever icon a row happens to carry.
struct AuthFieldRow<Content: View, Trailing: View>: View {
    let icon: String
    @ViewBuilder var content: Content
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 0) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .frame(width: AuthField.gutter)

            content
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)

            trailing
        }
        .frame(minHeight: Theme.Size.minTouchTarget + 6)
        .padding(.trailing, Theme.Space.xs)
    }
}

extension AuthFieldRow where Trailing == EmptyView {
    /// A row with no trailing accessory.
    ///
    /// The filler is `EmptyView` rather than a sized `Color`: a `Color` is
    /// greedy on both axes, and constraining only its width leaves the height
    /// free, which lets it stretch the row to whatever the screen offers.
    init(icon: String, @ViewBuilder content: () -> Content) {
        self.init(icon: icon, content: content, trailing: { EmptyView() })
    }
}

// MARK: - Error banner

/// Where an auth screen says what went wrong.
///
/// Between the fields and the button on both screens: the eye is already
/// there. At the top it is missed, and below the button it moves the button
/// out from under the thumb that was about to press it again.
struct AuthErrorBanner: View {
    let message: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(Theme.Palette.danger)

            Text(message)
                .font(.footnote)
                .foregroundStyle(Theme.Palette.label)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
        }
        .padding(Theme.Space.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                .fill(Theme.Palette.danger.opacity(0.10))
        )
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}

// MARK: - Email field

/// The one field both screens have, written once.
///
/// Pinned left-to-right whatever the interface is doing around it: an address
/// is a left-to-right string even in Persian, and letting it mirror renders it
/// unreadably — `user@host` becomes `host@user`.
struct AuthEmailField: View {
    let placeholder: String
    @Binding var text: String
    var submitLabel: SubmitLabel = .next
    var onSubmit: () -> Void = {}

    var body: some View {
        TextField(placeholder, text: $text)
            .textContentType(.username)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(submitLabel)
            .onSubmit(onSubmit)
            .environment(\.layoutDirection, .leftToRight)
            .multilineTextAlignment(.leading)
    }
}
