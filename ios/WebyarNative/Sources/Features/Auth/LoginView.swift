import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var isRequestingReset = false
    @State private var showResetSent = false

    @FocusState private var focus: Field?
    private enum Field { case email, password }

    private var language: Language { appState.language }

    private var canSubmit: Bool {
        Credentials.isPlausibleEmail(email) && !password.isEmpty && !isSubmitting
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    header
                        .padding(.top, Theme.Space.huge)

                    fields
                        .padding(.top, Theme.Space.xxl)

                    // The error sits between the fields and the button, where
                    // the eye already is — not at the top where it would be
                    // missed, and not below the button where it would push it.
                    if let errorMessage {
                        errorBanner(errorMessage)
                            .padding(.top, Theme.Space.md)
                    }

                    PrimaryButton(
                        title: Str.logIn(language),
                        isLoading: isSubmitting,
                        isEnabled: canSubmit,
                        action: submit
                    )
                    .padding(.top, Theme.Space.xl)

                    Button(action: requestReset) {
                        Text(Str.forgotPassword(language))
                            .font(.subheadline)
                            .foregroundStyle(Theme.Palette.brand)
                            .frame(minHeight: Theme.Size.minTouchTarget)
                    }
                    .buttonStyle(.plain)
                    .disabled(isRequestingReset)
                    .padding(.top, Theme.Space.xs)

                    Spacer(minLength: Theme.Space.xl)

                    languagePicker
                        .padding(.bottom, Theme.Space.lg)
                }
                .padding(.horizontal, Theme.screenInset)
                // Pins the language picker to the bottom on a tall screen
                // while still letting everything scroll on a short one or
                // when the keyboard is up.
                .frame(minHeight: proxy.size.height)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color(uiColor: .systemBackground))
        .onAppear {
            if let message = appState.sessionEndedMessage {
                errorMessage = message
                appState.clearSessionEndedMessage()
            }
        }
        .alert(Str.resetSentTitle(language), isPresented: $showResetSent) {
            Button(Str.ok(language), role: .cancel) {}
        } message: {
            Text(Str.resetSentBody(language))
        }
    }

    // MARK: - Pieces

    private var header: some View {
        VStack(spacing: Theme.Space.lg) {
            BrandMark(size: 68)

            VStack(spacing: Theme.Space.xs) {
                Text(Str.loginTitle(language))
                    .font(Theme.Typo.hero)
                    .foregroundStyle(Theme.Palette.label)

                Text(Str.loginSubtitle(language))
                    .font(.subheadline)
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }

    private var fields: some View {
        // One rounded container holding both fields with a hairline between
        // them — the inset-grouped form iOS users already know.
        VStack(spacing: 0) {
            fieldRow(icon: "envelope") {
                TextField(Str.emailLabel(language), text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
                    // An address is a left-to-right string even in Persian;
                    // letting it mirror would render it unreadably.
                    .environment(\.layoutDirection, .leftToRight)
                    .multilineTextAlignment(.leading)
            }

            Divider()
                .padding(.leading, Theme.Space.huge + Theme.Space.xs)

            fieldRow(icon: "lock") {
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
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .strokeBorder(Theme.Palette.separator.opacity(0.6), lineWidth: 0.5)
        )
    }

    /// One field row: a fixed-width icon gutter, the control, and an optional
    /// trailing accessory. The fixed gutter is what keeps the two fields'
    /// text starting on exactly the same vertical line.
    private func fieldRow<Content: View, Trailing: View>(
        icon: String,
        @ViewBuilder content: () -> Content,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: 0) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .frame(width: Theme.Space.huge + Theme.Space.xs)

            content()
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)

            trailing()
        }
        .frame(minHeight: Theme.Size.minTouchTarget + 6)
        .padding(.trailing, Theme.Space.xs)
    }

    /// A row with no trailing accessory.
    ///
    /// The filler is `EmptyView` rather than a sized `Color`: a `Color` is
    /// greedy on both axes, and constraining only its width leaves the height
    /// free, which lets it stretch the row to whatever the screen offers.
    private func fieldRow<Content: View>(
        icon: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        fieldRow(icon: icon, content: content, trailing: { EmptyView() })
            .padding(.trailing, Theme.Space.md)
    }

    private func errorBanner(_ message: String) -> some View {
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

    private var languagePicker: some View {
        HStack(spacing: Theme.Space.xs) {
            ForEach(Language.allCases) { option in
                Button {
                    withAnimation(Theme.Motion.standard) { appState.language = option }
                } label: {
                    Text(option.endonym)
                        .font(.subheadline.weight(option == language ? .semibold : .regular))
                        .foregroundStyle(option == language ? Theme.Palette.brand : Theme.Palette.labelSecondary)
                        .padding(.horizontal, Theme.Space.lg)
                        .frame(height: Theme.Size.minTouchTarget)
                        .background(
                            Capsule().fill(option == language
                                           ? Theme.Palette.brand.opacity(0.12)
                                           : Color.clear)
                        )
                }
                .buttonStyle(.plain)
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

    /// Sends a reset link for whatever is in the email field.
    ///
    /// The confirmation is shown whether or not the request succeeded at the
    /// application level, because the endpoint answers identically for an
    /// address that has an account and one that does not — reporting a
    /// difference here would turn the login screen into a way to test which
    /// addresses are registered. A transport failure is still reported: that
    /// one says nothing about the address.
    private func requestReset() {
        guard Credentials.isPlausibleEmail(email) else {
            focus = .email
            withAnimation(Theme.Motion.standard) { errorMessage = Str.resetNeedsEmail(language) }
            return
        }

        focus = nil
        isRequestingReset = true
        withAnimation(Theme.Motion.standard) { errorMessage = nil }

        Task {
            do {
                try await Backend.current.requestPasswordReset(email: Credentials.normalizeEmail(email))
                showResetSent = true
            } catch APIError.transport {
                withAnimation(Theme.Motion.standard) { errorMessage = Str.offlineBody(language) }
            } catch {
                showResetSent = true
            }
            isRequestingReset = false
        }
    }

    private func message(for error: APIError) -> String {
        switch error {
        case .transport:
            Str.offlineBody(language)
        case .unauthorized:
            Str.loginFailed(language)
        case .server(_, let message):
            // The API's own message is more specific than anything we could
            // guess, so prefer it when there is one.
            message ?? Str.loginFailed(language)
        case .decoding:
            Str.loginFailed(language)
        }
    }
}
