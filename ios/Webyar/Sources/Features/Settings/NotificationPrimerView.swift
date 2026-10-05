import SwiftUI

/// Asking in our own words, before iOS asks in its.
///
/// iOS shows an app's permission dialog exactly once, ever. Spend it at
/// launch, before the operator has seen a single conversation, and most
/// people tap "Don't allow" — after which the only way back is the Settings
/// app, which almost nobody finds. So the system prompt is never the first
/// thing shown: this is, and `requestAuthorization` comes once the operator
/// has read why, on the first screen where the question means anything.
///
/// One way on: "Continue" always leads to iOS's own question, where the
/// operator allows or declines. App Review refuses a screen before a
/// permission request that can be closed without reaching the request.
struct NotificationPrimerView: View {
    let language: Language
    let onContinue: () -> Void

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
                .font(.app(.title3, .semibold))
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

            PrimaryButton(title: SettingsStr.continueAction(language), action: onContinue)
        }
        .padding(.horizontal, Theme.Space.xxl)
        .padding(.bottom, Theme.Space.lg)
        .presentationDetents([.medium])
        .presentationDragIndicator(.hidden)
        .interactiveDismissDisabled(true)
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
