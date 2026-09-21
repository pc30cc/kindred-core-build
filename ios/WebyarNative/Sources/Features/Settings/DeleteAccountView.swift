import SwiftUI

/// Removing your own account, from inside the app.
///
/// Apple requires an app that signs people into an account to let them start
/// deleting it here rather than by writing an email (App Store Review
/// Guideline 5.1.1(v)). It is also the right thing on its own terms: an
/// operator who leaves a job should be able to take themselves off the
/// company's tools from the phone in their hand.
///
/// The screen's job is to make sure nobody does this by accident and that
/// everybody who does it knows what went. So it says what is removed, says
/// what is NOT — the conversations stay with the workspace, because they
/// belong to the customer — and asks for the password, which is the one
/// thing a phone left on a desk does not have.
struct DeleteAccountView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var password = ""
    @State private var isDeleting = false
    @State private var errorMessage: String?
    /// Set when the server refuses because this operator still owns
    /// workspaces. Not an error: a thing to go and do first.
    @State private var blockedBy: [String]?
    @State private var isConfirming = false

    @FocusState private var passwordFocused: Bool

    private var language: Language { appState.language }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Theme.Space.md) {
                    Image(systemName: "trash")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(Theme.Palette.danger)
                        .frame(width: 56, height: 56)
                        .background(Circle().fill(Theme.Palette.danger.opacity(0.12)))
                        .accessibilityHidden(true)

                    Text(Str.deleteAccountBody(language))
                        .font(.subheadline)
                        .foregroundStyle(Theme.Palette.label)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(Str.deleteAccountKeeps(language))
                        .font(.footnote)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, Theme.Space.xs)
                .listRowBackground(Color.clear)
            }

            if let blockedBy {
                Section {
                    Text(Str.deleteAccountOwnsBody(
                        language,
                        workspaces: blockedBy.joined(separator: "، ")
                    ))
                    .font(.footnote)
                    .foregroundStyle(Theme.Palette.label)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(A11y.deleteAccountBlocked)
                } header: {
                    Text(Str.deleteAccountOwnsTitle(language))
                }
            } else {
                Section {
                    SecureField(Str.passwordLabel(language), text: $password)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($passwordFocused)
                        .environment(\.layoutDirection, .leftToRight)
                        .multilineTextAlignment(.leading)
                        .frame(minHeight: Theme.Size.minTouchTarget - 10)
                        .accessibilityIdentifier(A11y.deleteAccountPassword)
                } header: {
                    Text(Str.deleteAccountConfirmPassword(language))
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(Theme.Palette.danger)
                    }
                }

                Section {
                    Button(role: .destructive, action: askToConfirm) {
                        HStack {
                            Text(Str.deleteAccountFinal(language))
                            Spacer(minLength: Theme.Space.sm)
                            if isDeleting { ProgressView() }
                        }
                        .frame(minHeight: Theme.Size.minTouchTarget - 10)
                    }
                    // Only while the request is in flight. It used to be
                    // disabled until a password was typed as well, which is
                    // the one thing a button on a screen with a single
                    // control must not be: the password field is under a
                    // paragraph of explanation, so somebody who has not
                    // scrolled to it sees a red button that does nothing at
                    // all when pressed, and concludes the feature is broken.
                    // It says what it wants instead.
                    .disabled(isDeleting)
                    .accessibilityIdentifier(A11y.deleteAccountSubmit)
                }
            }
        }
        .listStyle(.insetGrouped)
        .dismissesKeyboardOnTap()
        .navigationTitle(Str.deleteAccount(language))
        .navigationBarTitleDisplayMode(.inline)
        .animation(Theme.Motion.standard, value: blockedBy)
        // Typing is the answer to both things this screen says in red — "you
        // have not entered it" and "that one is wrong" — so the complaint
        // goes as soon as it is being answered.
        .onChange(of: password) { _, _ in
            guard errorMessage != nil else { return }
            withAnimation(Theme.Motion.standard) { errorMessage = nil }
        }
        // A destructive action gets the system's own confirmation, because
        // that is the one people have learned to read.
        .confirmationDialog(
            Str.deleteAccountFinal(language),
            isPresented: $isConfirming,
            titleVisibility: .visible
        ) {
            Button(Str.deleteAccountFinal(language), role: .destructive) { submit() }
                .accessibilityIdentifier(A11y.deleteAccountConfirm)
            Button(Str.cancel(language), role: .cancel) {}
        } message: {
            Text(Str.deleteAccountBody(language))
        }
    }

    /// The red button's job: either say what is missing, or ask.
    ///
    /// The hop before presenting is deliberate. Putting the keyboard away and
    /// raising a dialog in the same turn of the run loop asks UIKit to present
    /// over a view that is mid-way through resigning first responder, and the
    /// presentation is sometimes dropped on the floor — the keyboard goes
    /// down, nothing comes up, and the button looks broken. Letting the
    /// dismissal land first costs one frame.
    private func askToConfirm() {
        guard !password.isEmpty else {
            passwordFocused = true
            withAnimation(Theme.Motion.standard) {
                errorMessage = Str.deleteAccountConfirmPassword(language)
            }
            return
        }

        passwordFocused = false
        Task { @MainActor in isConfirming = true }
    }

    private func submit() {
        isDeleting = true
        withAnimation(Theme.Motion.standard) { errorMessage = nil }

        Task {
            do {
                switch try await Backend.current.deleteAccount(password: password) {
                case .deleted:
                    // Straight to the login screen. There is no account to
                    // sign out of any more, so this does not go through
                    // `signOut()` — the server has already revoked every
                    // session, including this one.
                    await appState.accountWasDeleted()
                case .blockedByOwnedWorkspaces(let names):
                    withAnimation(Theme.Motion.standard) { blockedBy = names }
                }
            } catch APIError.unauthorized {
                await appState.handleUnauthorized()
            } catch let error as APIError {
                withAnimation(Theme.Motion.standard) {
                    errorMessage = error.text(
                        language,
                        unauthorized: Str.deleteAccountWrongPassword(language)
                    )
                }
            } catch {
                withAnimation(Theme.Motion.standard) {
                    errorMessage = Str.saveFailed(language)
                }
            }
            isDeleting = false
        }
    }
}
