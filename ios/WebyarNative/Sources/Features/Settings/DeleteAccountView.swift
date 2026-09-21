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
                } header: {
                    Text(Str.deleteAccountConfirmPassword(language))
                } footer: {
                    if let errorMessage {
                        Text(errorMessage)
                            .foregroundStyle(Theme.Palette.danger)
                    }
                }

                Section {
                    Button(role: .destructive) {
                        passwordFocused = false
                        isConfirming = true
                    } label: {
                        HStack {
                            Text(Str.deleteAccountFinal(language))
                            Spacer(minLength: Theme.Space.sm)
                            if isDeleting { ProgressView() }
                        }
                    }
                    .disabled(password.isEmpty || isDeleting)
                }
            }
        }
        .listStyle(.insetGrouped)
        .dismissesKeyboardOnTap()
        .navigationTitle(Str.deleteAccount(language))
        .navigationBarTitleDisplayMode(.inline)
        .animation(Theme.Motion.standard, value: blockedBy)
        // A destructive action gets the system's own confirmation, because
        // that is the one people have learned to read.
        .confirmationDialog(
            Str.deleteAccountFinal(language),
            isPresented: $isConfirming,
            titleVisibility: .visible
        ) {
            Button(Str.deleteAccountFinal(language), role: .destructive) { submit() }
            Button(Str.cancel(language), role: .cancel) {}
        } message: {
            Text(Str.deleteAccountBody(language))
        }
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
