import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    @FocusState private var focus: Field?
    private enum Field { case email, password }

    private var language: Language { appState.language }

    private var canSubmit: Bool {
        Credentials.isPlausibleEmail(email) && !password.isEmpty && !isSubmitting
    }

    var body: some View {
        // A stack, because "forgot password" is a place now rather than a
        // button that fires a request from under your finger. The bar is
        // hidden here and comes back on the pushed screen, which is where a
        // back button belongs.
        NavigationStack {
            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        // Flexible gaps above and below centre the form in
                        // whatever height is left rather than pinning it to
                        // the top and leaving one dead band underneath. The
                        // minimum keeps it clear of the notch on a short
                        // screen and with the keyboard up.
                        Spacer(minLength: Theme.Space.huge)

                        header

                        AuthCard { fields }
                            .padding(.top, Theme.Space.xxl)

                        if let errorMessage {
                            AuthErrorBanner(message: errorMessage)
                                .padding(.top, Theme.Space.md)
                        }

                        PrimaryButton(
                            title: Str.logIn(language),
                            isLoading: isSubmitting,
                            isEnabled: canSubmit,
                            action: submit
                        )
                        .padding(.top, Theme.Space.xl)

                        NavigationLink {
                            PasswordResetView(prefilledEmail: email)
                        } label: {
                            Text(Str.forgotPassword(language))
                                .font(.app(.subheadline))
                                .foregroundStyle(Theme.Palette.brand)
                                .frame(minHeight: Theme.Size.minTouchTarget)
                        }
                        .buttonStyle(.plain)
                        .padding(.top, Theme.Space.xs)

                        if !appState.legalLinks.isEmpty {
                            LegalLinksFooter(links: appState.legalLinks, language: language)
                                .padding(.top, Theme.Space.sm)
                        }

                        Spacer(minLength: Theme.Space.huge)

                        // Room for the name signed at the foot of the screen
                        // (`brandFooter()` below), so on a short screen the
                        // form stops above it rather than under it.
                        Color.clear.frame(height: BrandFooter.clearance)
                    }
                    .padding(.horizontal, Theme.screenInset)
                    // Lets the two spacers do their work on a tall screen,
                    // while everything still scrolls on a short one or when
                    // the keyboard is up.
                    .frame(minHeight: proxy.size.height)
                    .dismissesKeyboardOnTap()
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollBounceBehavior(.basedOnSize)
            }
            .background(AuthBackdrop())
            .toolbar(.hidden, for: .navigationBar)
        }
        // On the stack rather than on this screen, so it stays put while
        // password reset slides in over it: the same place on both screens,
        // and the same place as on the launch screen this one fades in from.
        .brandFooter()
        .onAppear {
            if let message = appState.sessionEndedMessage {
                errorMessage = message
                appState.clearSessionEndedMessage()
            }
        }
    }

    // MARK: - Pieces

    /// What this screen is, and nothing else.
    ///
    /// The greeting used to be set at `largeTitle`/bold, which on a phone is
    /// 34 points of "Welcome back" — the loudest thing on a screen whose job
    /// is two fields and a button. It is a greeting, so it is sized like one.
    ///
    /// No wordmark above it, or anywhere in the form: the only mark on this
    /// screen is the launch screen's small "WEBYAR AI" at its foot.
    private var header: some View {
        VStack(spacing: Theme.Space.xxs) {
            Text(Str.loginTitle(language))
                .font(.app(.title3, .semibold))
                .foregroundStyle(Theme.Palette.label)

            Text(Str.loginSubtitle(language))
                .font(.app(.footnote))
                .foregroundStyle(Theme.Palette.labelSecondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }

    private var fields: some View {
        AuthFieldGroup {
            AuthFieldRow(icon: "envelope") {
                AuthEmailField(
                    placeholder: Str.emailLabel(language),
                    text: $email,
                    onSubmit: { focus = .password }
                )
                .focused($focus, equals: .email)
            }
            .padding(.trailing, Theme.Space.md)

            Divider()
                .padding(.leading, AuthField.gutter)

            AuthFieldRow(icon: "lock") {
                Group {
                    if showPassword {
                        TextField(Str.passwordLabel(language), text: $password)
                    } else {
                        SecureField(Str.passwordLabel(language), text: $password)
                    }
                }
                .textContentType(.password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focus, equals: .password)
                .onSubmit { if canSubmit { submit() } }
                .environment(\.layoutDirection, .leftToRight)
                .multilineTextAlignment(.leading)
            } trailing: {
                Button {
                    showPassword.toggle()
                } label: {
                    Image(systemName: showPassword ? "eye.slash" : "eye")
                        .font(.system(size: 17))
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Str.passwordLabel(language))
            }
        }
    }

    // MARK: - Actions

    private func submit() {
        focus = nil
        isSubmitting = true
        withAnimation(Theme.Motion.standard) { errorMessage = nil }

        Task {
            do {
                let user = try await Backend.current.logIn(
                    email: Credentials.normalizeEmail(email),
                    password: Credentials.stripInvisible(password)
                )
                await appState.signedIn(user)
            } catch let error as APIError {
                withAnimation(Theme.Motion.standard) {
                    errorMessage = message(for: error)
                }
            } catch {
                withAnimation(Theme.Motion.standard) {
                    errorMessage = Str.loginFailed(language)
                }
            }
            isSubmitting = false
        }
    }

    private func message(for error: APIError) -> String {
        // Here `unauthorized` is a wrong email or password, not a session
        // that ran out — there is no session yet.
        error.text(language, unauthorized: Str.loginFailed(language))
    }
}

/// The privacy policy and terms of use, side by side under the form.
private struct LegalLinksFooter: View {
    let links: LegalLinks
    let language: Language
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            if let privacy = links.privacyPolicy {
                link(SettingsStr.privacyPolicy(language), url: privacy)
                    .accessibilityIdentifier(A11y.loginPrivacyPolicy)
            }
            if links.privacyPolicy != nil, links.terms != nil {
                Text("·")
                    .font(.app(.footnote))
                    .foregroundStyle(Theme.Palette.labelTertiary)
                    .accessibilityHidden(true)
            }
            if let terms = links.terms {
                link(SettingsStr.termsOfUse(language), url: terms)
                    .accessibilityIdentifier(A11y.loginTerms)
            }
        }
    }

    private func link(_ title: String, url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            Text(title)
                .font(.app(.footnote))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .underline()
                .frame(minHeight: Theme.Size.minTouchTarget)
        }
        .buttonStyle(.plain)
    }
}
