import SwiftUI

/// Sign-in: the brand on a deep blue panel with what the app does, and the
/// form on a glass card beside it. In a narrow window the panel folds away
/// and the card stands alone — as on Windows.
struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var email = ""
    @State private var password = ""
    @State private var remember = false
    @State private var busy = false
    @State private var error: String?
    @State private var resetOpen = false
    @FocusState private var focus: Field?

    enum Field { case email, password }

    var body: some View {
        GeometryReader { geo in
            let wide = geo.size.width >= 900
            HStack(spacing: 16) {
                if wide {
                    BrandPanel()
                        .frame(maxWidth: 560)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                ZStack {
                    form(showLogo: !wide)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .padding(16)
            .animation(.smooth, value: wide)
        }
        .background(LoginBackdrop())
        .onAppear(perform: load)
        .sheet(isPresented: $resetOpen) {
            PasswordResetSheet(email: email.trimmingCharacters(in: .whitespaces)) { sent in
                if let sent { email = sent }
            }
            .environment(app)
            .appEnvironment(app)
        }
    }

    private func load() {
        if let saved = SavedLogin.read() {
            email = saved.email
            password = saved.password
            remember = true
        }
        focus = email.isEmpty ? .email : .password
    }

    private func form(showLogo: Bool) -> some View {
        let s = app.strings
        return VStack(alignment: .leading, spacing: 18) {
            if showLogo {
                Image("BrandMark").resizable().frame(width: 60, height: 60)
                    .frame(maxWidth: .infinity)
                    .shadow(color: Palette.brand.opacity(0.3), radius: 12, y: 6)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(s["loginTitle"]).appFont(26, .bold)
                Text(s["loginSubtitle"]).appFont(14).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
            }
            if let error {
                Banner(severity: .error, message: error)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            field(s["emailLabel"], systemImage: "envelope") {
                TextField("name@company.com", text: $email)
                    .textContentType(.username)
                    .focused($focus, equals: .email)
                    .onSubmit { focus = .password }
            }
            field(s["passwordLabel"], systemImage: "lock") {
                SecureField("", text: $password)
                    .textContentType(.password)
                    .focused($focus, equals: .password)
                    .onSubmit(signIn)
            }
            HStack {
                Toggle(s["rememberMe"], isOn: $remember).toggleStyle(.checkbox).appFont(13)
                Spacer()
                Button(s["forgotPassword"]) { resetOpen = true }
                    .buttonStyle(.link)
                    .appFont(13)
            }
            Button(action: signIn) {
                HStack(spacing: 8) {
                    if busy { ProgressView().controlSize(.small).tint(.white) }
                    Text(busy ? s["signingIn"] : s["logIn"]).appFont(15, .semibold)
                }
                .frame(maxWidth: .infinity, minHeight: 30)
            }
            .prominentButton()
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(busy || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)

            Divider().padding(.top, 4)
            HStack {
                Label(s["language"], systemImage: "globe").appFont(12.5).foregroundStyle(Palette.text2)
                Spacer()
                Picker("", selection: Binding(get: { app.strings.language }, set: { app.setLanguage($0); error = nil })) {
                    ForEach(Language.allCases) { Text($0.nativeName).tag($0) }
                }
                .labelsHidden()
                .fixedSize()
            }
        }
        .padding(.horizontal, 36)
        .padding(.vertical, 34)
        .frame(width: 440)
        .glassCard(24)
        .shadow(color: .black.opacity(0.08), radius: 30, y: 12)
        .disabled(busy)
    }

    private func field<Content: View>(_ label: String, systemImage: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).appFont(13, .semibold)
            HStack(spacing: 10) {
                Image(systemName: systemImage).foregroundStyle(Palette.text3).frame(width: 16)
                content()
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
            }
            .environment(\.layoutDirection, .leftToRight)
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(Palette.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.lineStrong, lineWidth: 1))
        }
    }

    private func signIn() {
        let s = app.strings
        let mail = email.trimmingCharacters(in: .whitespaces)
        guard !mail.isEmpty, !password.isEmpty, !busy else { return }
        busy = true
        withAnimation { error = nil }
        Task {
            do {
                try await app.signIn(email: mail, password: password, remember: remember)
                password = ""
            } catch {
                Log.error("login", error)
                let status = error.apiError?.status
                withAnimation {
                    self.error = [400, 401, 403].contains(status ?? 0) ? s["loginFailed"] : ErrorText.of(error, s, unauthorized: s["loginFailed"])
                }
            }
            busy = false
        }
    }
}

/// A soft wash of the brand behind the sign-in page, so the glass has something to refract.
struct LoginBackdrop: View {
    var body: some View {
        ZStack {
            Palette.appBackground
            Circle().fill(Palette.brand.opacity(0.18)).frame(width: 620).blur(radius: 120).offset(x: 320, y: -260)
            Circle().fill(Palette.ai.opacity(0.14)).frame(width: 520).blur(radius: 120).offset(x: -260, y: 300)
        }
        .ignoresSafeArea()
    }
}

/// The brand panel: logo, tagline and the three things the app does.
struct BrandPanel: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        ZStack {
            Palette.brandPanel
            Circle().fill(.white.opacity(0.09)).frame(width: 420).offset(x: 180, y: -240)
            Circle().fill(.white.opacity(0.07)).frame(width: 300).offset(x: -200, y: 260)
            ViewThatFits(in: .vertical) {
                content(s)
                content(s).scaleEffect(0.82)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func content(_ s: Strings) -> some View {
        VStack(alignment: .leading, spacing: 28) {
            Image("BrandMark").resizable().frame(width: 72, height: 72)
                .shadow(color: .black.opacity(0.25), radius: 14, y: 8)
            VStack(alignment: .leading, spacing: 10) {
                Text(s["appName"]).appFont(34, .bold).foregroundStyle(.white)
                Text(s["desktopTagline"]).appFont(16).foregroundStyle(Color(hex: 0xD6E1FF)).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 14) {
                feature("bubble.left.and.bubble.right.fill", s["loginFeatureInbox"])
                feature("sparkles", s["loginFeatureAi"])
                feature("phone.fill", s["loginFeatureCalls"])
            }
        }
        .padding(44)
        .frame(maxWidth: 460, alignment: .leading)
    }

    private func feature(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(.white.opacity(0.15), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            Text(text).appFont(14).foregroundStyle(Color(hex: 0xEAF0FF)).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// "Forgot password": the address, then a link by email.
struct PasswordResetSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var email: String
    var onDone: (String?) -> Void
    @State private var busy = false
    @State private var sent = false
    @State private var error: String?

    var body: some View {
        let s = app.strings
        VStack(alignment: .leading, spacing: 14) {
            Text(sent ? s["resetSentTitle"] : s["resetTitle"]).appFont(18, .bold)
            if sent {
                Text(s.get("resetSentDetail", "email", email) + "\n\n" + s["resetCheckSpam"]).appFont(13).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(s["resetSubtitle"]).appFont(13).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
                TextField("name@company.com", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .environment(\.layoutDirection, .leftToRight)
                    .onSubmit(send)
                if let error { Text(error).appFont(12).foregroundStyle(Palette.danger) }
            }
            HStack {
                Spacer()
                if sent {
                    Button(s["ok"]) { onDone(email); dismiss() }.keyboardShortcut(.defaultAction)
                } else {
                    Button(s["cancel"]) { dismiss() }.keyboardShortcut(.cancelAction)
                    Button(s["sendResetLink"], action: send)
                        .keyboardShortcut(.defaultAction)
                        .disabled(!Self.isEmail(email) || busy)
                }
            }
        }
        .padding(22)
        .frame(width: 400)
    }

    private func send() {
        guard Self.isEmail(email), !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                let mail = email.trimmingCharacters(in: .whitespaces)
                try await app.api.sendPasswordReset(email: mail, locale: app.strings.language.code)
                email = mail
                sent = true
            } catch {
                Log.error("password reset", error)
                self.error = ErrorText.of(error, app.strings)
            }
            busy = false
        }
    }

    static func isEmail(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard let at = t.firstIndex(of: "@"), at > t.startIndex, let dot = t.lastIndex(of: ".") else { return false }
        return dot > t.index(after: at) && !t.hasSuffix(".")
    }
}
