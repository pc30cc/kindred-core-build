import SwiftUI

/// Where an operator who cannot get in asks for a way back.
///
/// This used to be a button on the login screen that fired the request
/// against whatever was in the email field and then put up an alert. Three
/// things were wrong with that. It asked for nothing, so there was nowhere to
/// tell somebody what was about to happen or which address it would go to; it
/// refused outright if the field was empty, which is the state anybody who
/// tapped it was actually in; and an alert saying "check your email" over the
/// login form gives no way to correct a typo in the address you cannot see.
///
/// So it is a place. It asks for the address, it says what the link does and
/// how long it lasts, and when it has gone it shows where it went.
struct PasswordResetView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    /// Whatever was already typed on the login screen, so the common case —
    /// right address, wrong password — does not ask for it twice.
    var prefilledEmail: String = ""

    @State private var email = ""
    @State private var isSending = false
    @State private var errorMessage: String?
    /// The address the link went to, which is also what says we are done.
    @State private var sentTo: String?

    @FocusState private var emailFocused: Bool

    private var language: Language { appState.language }

    private var canSend: Bool {
        Credentials.isPlausibleEmail(email) && !isSending
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: Theme.Space.xl)

                    if let sentTo {
                        confirmation(sentTo)
                    } else {
                        form
                    }

                    Spacer(minLength: Theme.Space.xl)
                }
                .padding(.horizontal, Theme.screenInset)
                .frame(minHeight: proxy.size.height)
                .dismissesKeyboardOnTap()
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(AuthBackdrop())
        .navigationBarTitleDisplayMode(.inline)
        .animation(Theme.Motion.standard, value: sentTo)
        .onAppear {
            guard email.isEmpty else { return }
            email = prefilledEmail
            // Straight into the field when there is nothing to prefill. The
            // whole screen is one question; making somebody tap to answer it
            // is a tap that tells us nothing.
            if prefilledEmail.isEmpty { emailFocused = true }
        }
    }

    // MARK: - Asking

    private var form: some View {
        VStack(spacing: 0) {
            VStack(spacing: Theme.Space.sm) {
                glyph("key.horizontal.fill")

                Text(Str.resetTitle(language))
                    .font(.app(.title3, weight: .semibold))
                    .foregroundStyle(Theme.Palette.label)

                Text(Str.resetSubtitle(language))
                    .font(.app(.footnote))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .multilineTextAlignment(.center)
                    // Left to its own devices a two-line explanation under a
                    // one-line title stretches to the full screen width and
                    // reads as a paragraph rather than as a caption.
                    .frame(maxWidth: 320)
            }
            .frame(maxWidth: .infinity)

            AuthCard {
                AuthFieldRow(icon: "envelope") {
                    AuthEmailField(
                        placeholder: Str.emailLabel(language),
                        text: $email,
                        submitLabel: .send,
                        onSubmit: { if canSend { send() } }
                    )
                    .focused($emailFocused)
                }
                .padding(.trailing, Theme.Space.md)
            }
            .padding(.top, Theme.Space.xxl)

            if let errorMessage {
                AuthErrorBanner(message: errorMessage)
                    .padding(.top, Theme.Space.md)
            }

            PrimaryButton(
                title: Str.sendResetLink(language),
                isLoading: isSending,
                isEnabled: canSend,
                action: send
            )
            .padding(.top, Theme.Space.xl)
        }
    }

    // MARK: - Done

    private func confirmation(_ address: String) -> some View {
        VStack(spacing: Theme.Space.md) {
            glyph("envelope.fill")

            Text(Str.resetSentTitle(language))
                .font(.app(.title3, weight: .semibold))
                .foregroundStyle(Theme.Palette.label)

            // The address is inside a sentence, so it cannot be pinned
            // left-to-right as a whole without turning the Persian around it
            // the wrong way. `Text` handles the mixed run correctly on its
            // own; what it needs is only to be told which way the sentence
            // goes, which the environment already says.
            Text(Str.resetSentDetail(language, email: address))
                .font(.app(.footnote))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)

            Text(Str.resetCheckSpam(language))
                .font(.app(.caption))
                .foregroundStyle(Theme.Palette.labelSecondary.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(.top, Theme.Space.xxs)

            PrimaryButton(title: Str.backToLogin(language)) { dismiss() }
                .padding(.top, Theme.Space.xl)
        }
        .frame(maxWidth: .infinity)
        .transition(.opacity)
    }

    /// The one piece of ornament on either state: the subject of the screen,
    /// in a soft brand disc. It is what stops a screen holding one field from
    /// looking like an error page.
    private func glyph(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 26, weight: .semibold))
            .foregroundStyle(Theme.Palette.brand)
            .frame(width: 64, height: 64)
            .background(Circle().fill(Theme.Palette.brand.opacity(0.12)))
            .padding(.bottom, Theme.Space.xs)
            .accessibilityHidden(true)
    }

    // MARK: - Actions

    /// Asks for the link.
    ///
    /// The confirmation is shown whether or not the request succeeded at the
    /// application level, because the endpoint answers identically for an
    /// address that has an account and one that does not — reporting a
    /// difference here would turn this screen into a way to test which
    /// addresses are registered. A transport failure is still reported: that
    /// one says nothing about the address, only that we never asked.
    private func send() {
        emailFocused = false
        isSending = true
        withAnimation(Theme.Motion.standard) { errorMessage = nil }

        let address = Credentials.normalizeEmail(email)

        Task {
            do {
                try await Backend.current.requestPasswordReset(
                    email: address,
                    locale: language.rawValue
                )
                sentTo = address
                Haptics.success()
            } catch APIError.transport {
                withAnimation(Theme.Motion.standard) { errorMessage = Str.offlineBody(language) }
            } catch {
                sentTo = address
            }
            isSending = false
        }
    }
}
