import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    /// How many times this screen has been told no.
    ///
    /// A counter rather than the message, because two wrong passwords in a
    /// row produce the same string and comparing strings would animate only
    /// the first of them.
    @State private var rejections = 0

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
                            // What a wrong password looks like before the
                            // sentence under it has been read.
                            .shakesOnChange(rejections)

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

                        footerMark
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

    /// What this screen is, and nothing else.
    ///
    /// The greeting used to be set at `largeTitle`/bold, which on a phone is
    /// 34 points of "Welcome back" — the loudest thing on a screen whose job
    /// is two fields and a button. It is a greeting, so it is sized like one.
    ///
    /// The wordmark used to sit above it and now sits at the foot of the
    /// screen: see `footerMark`.
    private var header: some View {
        VStack(spacing: Theme.Space.xxs) {
            Text(Str.loginTitle(language))
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.Palette.label)

            Text(Str.loginSubtitle(language))
                .font(.footnote)
                .foregroundStyle(Theme.Palette.labelSecondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }

    /// The mark, small and quiet, at the bottom of the screen.
    ///
    /// A wordmark over the fields is a sign above a door: it tells you where
    /// you are before you are anywhere. But everyone here has already opened
    /// this app — they saw the mark on the icon they tapped and again on the
    /// launch screen — so a third, large one directly above the form is the
    /// biggest thing on the screen saying the thing you already know, and it
    /// pushes the two fields you came for down under it.
    ///
    /// So it moves to the foot: still present, signed rather than announced,
    /// the way a name is set at the bottom of a card. Small enough to be a
    /// signature (the login screen's mark was 30 points; this is half that),
    /// dimmed so it sits behind the form in the eye's order, and last in the
    /// scroll so the keyboard pushes it away instead of covering it.
    private var footerMark: some View {
        BrandWordmark(language: language, size: 15)
            .opacity(0.55)
            .padding(.top, Theme.Space.xxl)
            .padding(.bottom, Theme.Space.xs)
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
                rejections += 1
            } catch {
                withAnimation(Theme.Motion.standard) {
                    errorMessage = Str.loginFailed(language)
                }
                rejections += 1
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
