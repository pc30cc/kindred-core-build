import SwiftUI

/// Asking in our own words, before iOS asks in its.
///
/// iOS shows an app's permission dialog exactly once, ever. Spend it at
/// launch, before the operator has seen a single conversation, and most
/// people tap "Don't allow" — after which the only way back is the Settings
/// app, which almost nobody finds. So the system prompt is never the first
/// thing asked: this is, and `requestAuthorization` is only called by
/// somebody who has already said yes to a screen that explained why.
///
/// Declining here costs nothing and asks nothing of iOS, so the real prompt
/// is still there to be spent later from Settings → Notifications.
struct NotificationPrimerView: View {
    let language: Language
    let onAllow: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: Theme.Space.xl)

            Image(systemName: "bell.badge.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(Theme.Palette.brand)
                .frame(width: 84, height: 84)
                .background(Circle().fill(Theme.Palette.brand.opacity(0.12)))
                .accessibilityHidden(true)

            Text(Str.pushPrimerTitle(language))
                .font(.app(.title3, weight: .semibold))
                .foregroundStyle(Theme.Palette.label)
                .multilineTextAlignment(.center)
                .padding(.top, Theme.Space.xl)

            Text(Str.pushPrimerBody(language))
                .font(.app(.subheadline))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, Theme.Space.sm)

            Spacer(minLength: Theme.Space.xl)

            PrimaryButton(title: Str.pushTurnOn(language), action: onAllow)

            Button(action: onDismiss) {
                Text(Str.pushNotNow(language))
                    .font(.app(.subheadline))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .frame(minHeight: Theme.Size.minTouchTarget)
            }
            .buttonStyle(.plain)
            .padding(.top, Theme.Space.xs)
        }
        .padding(.horizontal, Theme.Space.xxl)
        .padding(.bottom, Theme.Space.lg)
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(false)
    }
}

/// Whether this install has already been asked, in our words.
///
/// A per-viewer convenience with nothing to protect, so `UserDefaults` is the
/// right home: losing it on reinstall simply means asking once more, which is
/// the correct behaviour for a fresh install anyway.
enum NotificationPrimer {
    private static let key = "push.primerShown"

    static var hasBeenShown: Bool {
        UserDefaults.standard.bool(forKey: key)
    }

    /// Whether this run was asked not to interrupt.
    ///
    /// The same argument the promotion card honours, for the same reason and
    /// with the same fence: this is a full-screen interruption whose timing
    /// depends on how quickly the inbox loads, so it lands over some runs of
    /// a UI suite and not others. It took two `ShortcutTests` down the first
    /// time it shipped. Debug-only, so no shipped build can be told to skip
    /// asking.
    static var isSuppressed: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-WebyarNoPromotions")
        #else
        false
        #endif
    }

    static func markShown() {
        UserDefaults.standard.set(true, forKey: key)
    }
}
