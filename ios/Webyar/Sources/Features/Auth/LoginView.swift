import SwiftUI

/// Sign in.
///
/// One clear hierarchy, top to bottom: the brand's mark as the hero, a short
/// greeting, the two fields on one card, the one action, and — quiet, under
/// the form — the way back in (forgot password) and the brand's own links:
/// its website, by its name, and the privacy policy and terms. The language
/// picker sits in the corner, out of the way of all of it. Signed at the foot
/// of the screen by the same name as the launch screen (`brandFooter()`).
///
/// Everything is the brand's from its kit: the mark (`BrandMark`), its glow,
/// the call to action and the links (`AuthPalette`), with nothing named after
/// a brand here — the same file draws both apps. Numbers from `Theme`: the
/// gaps step on the 4-point rhythm, every control is a 44-point target, and
/// all type is a text style, so it grows with Dynamic Type and the screen
/// scrolls when it has to (a small iPhone, the keyboard up).
struct LoginView: View {
    @Environment(AppState.self) private var appState

    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    /// Failed attempts on this screen: each one is felt as well as read.
    @State private var failures = 0

    @FocusState private var focus: Field?
    private enum Field { case email, password }

    /// The hero mark grows with the text, up to a point: at the largest sizes
    /// the words matter more than the mark does.
    @ScaledMetric(relativeTo: .largeTitle) private var markSize: CGFloat = 72

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
                        // minimum keeps the mark clear of the corner's
                        // language picker on a short screen.
                        Spacer(minLength: Theme.Space.lg)

                        hero

                        AuthCard(isFocused: focus != nil) { fields }
                            .padding(.top, Theme.Space.xxl + Theme.Space.xs)

                        if let errorMessage {
                            AuthErrorBanner(message: errorMessage)
                                .padding(.top, Theme.Space.md)
                        }

                        PrimaryButton(
                            title: Str.logIn(language),
                            isLoading: isSubmitting,
                            isEnabled: canSubmit,
                            isAuth: true,
                            action: submit
                        )
                        .padding(.top, Theme.Space.xl + Theme.Space.xs)

                        NavigationLink {
                            PasswordResetView(prefilledEmail: email)
                        } label: {
                            Text(Str.forgotPassword(language))
                                .font(.app(.subheadline, .medium))
                                .foregroundStyle(AuthPalette.link)
                                .frame(minHeight: Theme.Size.minTouchTarget)
                                .padding(.horizontal, Theme.Space.sm)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .padding(.top, Theme.Space.xs)

                        Spacer(minLength: Theme.Space.xxl)

                        SignInLinks(
                            website: appState.signInWebsiteLink,
                            legal: appState.siteLegalLinks,
                            language: language
                        )

                        // Room for the name signed at the foot of the screen
                        // (`brandFooter()` below), so on a short screen the
                        // links stop above it rather than under it.
                        Color.clear.frame(height: BrandFooter.clearance + Theme.Space.xs)
                    }
                    .padding(.horizontal, Theme.screenInset + Theme.Space.xs)
                    // A form, not a banner: on a wide screen it keeps the
                    // width a phone gives it.
                    .frame(maxWidth: 440)
                    .frame(maxWidth: .infinity)
                    // Lets the two spacers do their work on a tall screen,
                    // while everything still scrolls on a short one or when
                    // the keyboard is up.
                    .frame(minHeight: proxy.size.height)
                    .dismissesKeyboardOnTap()
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollBounceBehavior(.basedOnSize)
            }
            // Above the scroll view rather than in it, so the form is centred
            // in the room under it and never slides beneath it.
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack {
                    Spacer(minLength: 0)
                    LanguageMenu()
                }
                .padding(.horizontal, Theme.screenInset)
                .padding(.top, Theme.Space.xs)
            }
            .background(AuthBackdrop())
            .toolbar(.hidden, for: .navigationBar)
        }
        // On the stack rather than on this screen, so it stays put while
        // password reset slides in over it: the same place on both screens,
        // and the same place as on the launch screen this one fades in from.
        .brandFooter()
        .sensoryFeedback(.error, trigger: failures)
        .onAppear {
            if let message = appState.sessionEndedMessage {
                errorMessage = message
                appState.clearSessionEndedMessage()
            }
        }
    }

    // MARK: - Pieces

    /// The brand's mark, lit from beneath by its own colour, and what this
    /// screen is: a greeting sized like one, and one line under it.
    private var hero: some View {
        VStack(spacing: Theme.Space.lg + Theme.Space.xs) {
            BrandMark(size: min(markSize, 104))
                .shadow(color: BrandPalette.bright.opacity(0.32), radius: 22, x: 0, y: 10)
                .shadow(color: .black.opacity(0.08), radius: 2, x: 0, y: 1)

            VStack(spacing: Theme.Space.xs + Theme.Space.xxs) {
                Text(Str.loginTitle(language))
                    .font(.app(.title2, .bold))
                    .foregroundStyle(Theme.Palette.label)
                    .accessibilityAddTraits(.isHeader)

                Text(Str.loginSubtitle(language))
                    .font(.app(.subheadline))
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }

    private var fields: some View {
        AuthFieldGroup {
            AuthFieldRow(icon: "envelope", isActive: focus == .email) {
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

            AuthFieldRow(icon: "lock", isActive: focus == .password) {
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
                .accessibilityAddTraits(showPassword ? .isSelected : [])
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
                failures += 1
            } catch {
                withAnimation(Theme.Motion.standard) {
                    errorMessage = Str.loginFailed(language)
                }
                failures += 1
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

// MARK: - Language

/// The interface's language, before there is a Settings screen to change it
/// in: a small globe and the language's own name, in the corner. The same
/// choice as Settings → Language, kept the same way.
private struct LanguageMenu: View {
    @Environment(AppState.self) private var appState

    private var language: Language { appState.language }

    var body: some View {
        Menu {
            Picker(
                Str.language(language),
                selection: Binding(get: { appState.language }, set: { appState.language = $0 })
            ) {
                ForEach(Language.allCases) { option in
                    Text(option.endonym).tag(option)
                }
            }
        } label: {
            HStack(spacing: Theme.Space.xs + Theme.Space.xxs) {
                Image(systemName: "globe")
                    .imageScale(.medium)
                Text(language.endonym)
            }
            .font(.app(.footnote, .semibold))
            .foregroundStyle(Theme.Palette.labelSecondary)
            .padding(.horizontal, Theme.Space.md)
            .frame(minHeight: Theme.Size.minTouchTarget - Theme.Space.sm)
            .background(Capsule().fill(.ultraThinMaterial))
            .overlay(Capsule().strokeBorder(Theme.Palette.separator.opacity(0.45), lineWidth: 0.5))
            // The capsule is drawn smaller than the target it answers to.
            .frame(minHeight: Theme.Size.minTouchTarget)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Str.language(language))
        .accessibilityValue(language.endonym)
        .accessibilityIdentifier(A11y.loginLanguage)
    }
}

// MARK: - Links under the form

/// The brand's website — by its name, never by its address (owner,
/// 2026-11-02: "don't show the address, make it a link") — then the privacy
/// policy and terms of use. Small and quiet: they are there for whoever looks
/// for them, not on the way to signing in. The website link names no plan,
/// price or activation (docs/operations/MOBILE_APP_PLAN.md).
private struct SignInLinks: View {
    let website: WebsiteLink?
    let legal: LegalLinks
    let language: Language
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(spacing: 0) {
            if let website {
                Button {
                    openURL(website.url)
                } label: {
                    // The arrow says it leaves the app; it points the
                    // reading direction's way (`arrow.up.forward`).
                    HStack(spacing: Theme.Space.xs) {
                        Text(website.title)
                        Image(systemName: "arrow.up.forward")
                            .imageScale(.small)
                            .font(.app(.caption2, .semibold))
                            .accessibilityHidden(true)
                    }
                    .font(.app(.footnote, .semibold))
                    .foregroundStyle(AuthPalette.link)
                    .frame(minHeight: Theme.Size.minTouchTarget)
                    .padding(.horizontal, Theme.Space.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(website.title)
                .accessibilityRemoveTraits(.isButton)
                .accessibilityAddTraits(.isLink)
                .accessibilityIdentifier(A11y.loginWebsite)
            }

            if !legal.isEmpty {
                LegalLinksFooter(links: legal, language: language)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }
}

/// The privacy policy and terms of use, side by side — or one above the
/// other, when the language's words and the type size leave no room for both
/// on one line.
private struct LegalLinksFooter: View {
    let links: LegalLinks
    let language: Language
    @Environment(\.openURL) private var openURL

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.xs) {
                privacy
                if links.privacyPolicy != nil, links.terms != nil {
                    Text(verbatim: "·")
                        .font(.app(.footnote))
                        .foregroundStyle(Theme.Palette.labelTertiary)
                        .accessibilityHidden(true)
                }
                terms
            }
            VStack(spacing: 0) {
                privacy
                terms
            }
        }
    }

    @ViewBuilder private var privacy: some View {
        if let url = links.privacyPolicy {
            link(SettingsStr.privacyPolicy(language), url: url)
                .accessibilityIdentifier(A11y.loginPrivacyPolicy)
        }
    }

    @ViewBuilder private var terms: some View {
        if let url = links.terms {
            link(SettingsStr.termsOfUse(language), url: url)
                .accessibilityIdentifier(A11y.loginTerms)
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
                .fixedSize()
                .frame(minHeight: Theme.Size.minTouchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityRemoveTraits(.isButton)
        .accessibilityAddTraits(.isLink)
    }
}
