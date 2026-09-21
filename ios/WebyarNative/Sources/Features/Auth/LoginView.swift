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
                                .font(.subheadline)
                                .foregroundStyle(Theme.Palette.brand)
                                .frame(minHeight: Theme.Size.minTouchTarget)
                        }
                        .buttonStyle(.plain)
                        .padding(.top, Theme.Space.xs)

                        Spacer(minLength: Theme.Space.huge)
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
        .onAppear {
            if let message = appState.sessionEndedMessage {
                errorMessage = message
                appState.clearSessionEndedMessage()
            }
        }
    }

    // MARK: - Pieces

    /// The wordmark, then what this screen is.
    ///
    /// The greeting used to be set at `largeTitle`/bold, which on a phone is
    /// 34 points of "Welcome back" — bigger than the product's own name
    /// directly above it, and the loudest thing on a screen whose job is two
    /// fields and a button. It is a greeting, so it is sized like one: the
    /// wordmark is the mark, the greeting is a line of text under it.
    private var header: some View {
        VStack(spacing: Theme.Space.lg) {
            BrandWordmark(language: language, size: 30)

            VStack(spacing: Theme.Space.xxs) {
                Text(Str.loginTitle(language))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.Palette.label)

                Text(Str.loginSubtitle(language))
                    .font(.footnote)
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    private var fields: some View {
        VStack(spacing: 0) {
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
