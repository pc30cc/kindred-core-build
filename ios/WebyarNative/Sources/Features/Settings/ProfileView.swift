import SwiftUI
import PhotosUI
import Observation

@MainActor
@Observable
final class ProfileViewModel {
    private(set) var account: Account?
    private(set) var isLoading = true
    private(set) var isSaving = false
    private(set) var isUploadingPhoto = false
    var name = ""
    var message: Banner?

    struct Banner: Identifiable, Equatable {
        enum Tone { case success, failure }
        let id = UUID()
        let text: String
        let tone: Tone
    }

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    var hasUnsavedName: Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed != (account?.profile?.fullName ?? "") && !trimmed.isEmpty
    }

    func load(appState: AppState) async {
        do {
            let loaded = try await api.account()
            account = loaded
            name = loaded.profile?.fullName ?? ""
            // Everywhere else reads the operator's photograph from here —
            // Settings' header, and their own face in the internal chat — so
            // uploading or removing one has to update the shared copy too.
            appState.adoptProfile(loaded.profile)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // The header falls back to what the session already knows.
        }
        isLoading = false
    }

    func saveName(appState: AppState) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isSaving = true
        do {
            account = try await api.updateProfile(fullName: trimmed, preferredLocale: nil)
            message = Banner(text: Str.saved(appState.language), tone: .success)
            Haptics.success()
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            message = Banner(text: Str.saveFailed(appState.language), tone: .failure)
        }
        isSaving = false
    }

    /// Sends a new profile photo.
    ///
    /// The payload is base64 inside JSON, so the encoded form is roughly a
    /// third larger than the file — which is exactly why the picked image is
    /// downscaled before it gets here rather than sent at full camera
    /// resolution.
    func upload(imageData: Data, contentType: String, appState: AppState) async {
        isUploadingPhoto = true
        do {
            if let profile = try await api.uploadAvatar(
                imageData: imageData,
                contentType: contentType,
                fileName: "avatar.jpg"
            ) {
                account = Account(
                    id: account?.id ?? "",
                    email: account?.email,
                    phone: account?.phone,
                    emailConfirmedAt: account?.emailConfirmedAt,
                    createdAt: account?.createdAt,
                    profile: profile
                )
            } else {
                await load(appState: appState)
            }
            message = Banner(text: Str.saved(appState.language), tone: .success)
            Haptics.success()
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            message = Banner(text: Str.saveFailed(appState.language), tone: .failure)
        }
        isUploadingPhoto = false
    }

    func removePhoto(appState: AppState) async {
        isUploadingPhoto = true
        do {
            try await api.deleteAvatar()
            await load(appState: appState)
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            message = Banner(text: Str.saveFailed(appState.language), tone: .failure)
        }
        isUploadingPhoto = false
    }
}

struct ProfileView: View {
    @Environment(AppState.self) private var appState
    @State private var model = ProfileViewModel()
    @State private var photoItem: PhotosPickerItem?
    @FocusState private var nameFocused: Bool

    private var language: Language { appState.language }

    /// The photograph to draw, from whichever copy arrived first.
    ///
    /// Settings has already fetched the operator's profile by the time this
    /// screen can be opened — it draws their face in the row you tapped to
    /// get here — so asking `appState` means the picture is known from the
    /// first frame rather than after this screen's own round trip. Without
    /// it, the avatar drew INITIALS for a moment and then replaced them with
    /// the photograph: initials are not a loading state, they look like the
    /// answer, and the swap reads as the screen changing its mind.
    private var avatarURL: String? {
        model.account?.profile?.avatarURL ?? appState.myAvatarURL
    }

    /// Whether we genuinely do not know yet.
    ///
    /// Only true on the rare path where this screen is reached before the
    /// shared profile has landed. Then the avatar shows the skeleton — the
    /// same shape every other picture in the app shows while it is still
    /// coming — rather than guessing.
    private var isAvatarUnknown: Bool {
        model.isUploadingPhoto || (model.isLoading && appState.profile == nil)
    }

    private var displayName: String {
        let typed = model.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return typed }
        return model.account?.displayName ?? appState.session.user?.displayName ?? "—"
    }

    var body: some View {
        @Bindable var model = model

        List {
            Section {
                VStack(spacing: Theme.Space.md) {
                    // Drawn exactly the way the workspace logo is: the URL
                    // is known from the first frame, so there is never a
                    // moment of initials that turns into a photograph.
                    Avatar(
                        name: displayName,
                        imageURL: avatarURL,
                        size: Theme.Size.avatarLarge,
                        isBusy: isAvatarUnknown
                    )

                    ChangePhotoButton(
                        title: Str.changePhoto(language),
                        selection: $photoItem,
                        isDisabled: model.isUploadingPhoto
                    )

                    if model.account?.profile?.avatarURL != nil {
                        Button(role: .destructive) {
                            Task { await model.removePhoto(appState: appState) }
                        } label: {
                            Text(Str.removePhoto(language))
                                .font(.app(.subheadline))
                        }
                        .disabled(model.isUploadingPhoto)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Space.md)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            Section {
                HStack(spacing: Theme.Space.lg) {
                    Text(Str.displayName(language))
                        .foregroundStyle(Theme.Palette.label)
                        .layoutPriority(1)
                        .fixedSize(horizontal: true, vertical: false)

                    TextField(Str.displayName(language), text: $model.name)
                        .multilineTextAlignment(.trailing)
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit { Task { await model.saveName(appState: appState) } }
                }
                .frame(minHeight: Theme.Size.minTouchTarget - 10)

                if let email = model.account?.email ?? appState.session.user?.email {
                    DetailRow(label: Str.emailLabel(language), value: email, isLatin: true)
                }

                if let account = model.account, !account.isEmailVerified {
                    Label(Str.emailNotVerified(language), systemImage: "exclamationmark.triangle.fill")
                        .font(.app(.footnote))
                        .foregroundStyle(Theme.Palette.warning)
                }
            } header: {
                Text(Str.profile(language))
            } footer: {
                // The save control only appears once there is something to
                // save, so the form never shows a button that would do nothing.
                if model.hasUnsavedName {
                    Button {
                        nameFocused = false
                        Task { await model.saveName(appState: appState) }
                    } label: {
                        HStack(spacing: Theme.Space.sm) {
                            if model.isSaving { ProgressView().controlSize(.small) }
                            Text(Str.save(language))
                        }
                        .font(.app(.subheadline, weight: .semibold))
                        .frame(minHeight: Theme.Size.minTouchTarget - 8)
                    }
                    .disabled(model.isSaving)
                    .padding(.top, Theme.Space.xs)
                }
            }
        }
        .listStyle(.insetGrouped)
        .dismissesKeyboardOnTap()
        .navigationTitle(Str.profile(language))
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(appState: appState) }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await handlePicked(item) }
        }
        .alert(
            model.message?.text ?? "",
            isPresented: Binding(
                get: { model.message != nil },
                set: { if !$0 { model.message = nil } }
            )
        ) {
            Button(Str.ok(language), role: .cancel) { model.message = nil }
        }
    }

    /// Loads the picked photo and shrinks it before upload.
    ///
    /// A modern phone photo is several megabytes, and base64 in a JSON body
    /// adds about a third on top. Downscaling to a size an avatar is ever
    /// displayed at keeps the request small enough to succeed on a phone
    /// connection, which matters more here than preserving detail nobody sees.
    private func handlePicked(_ item: PhotosPickerItem) async {
        guard let raw = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: raw)
        else {
            model.message = .init(text: Str.saveFailed(language), tone: .failure)
            return
        }

        guard let jpeg = Self.downscaledJPEG(image) else {
            model.message = .init(text: Str.photoTooLarge(language), tone: .failure)
            return
        }

        await model.upload(imageData: jpeg, contentType: "image/jpeg", appState: appState)
        photoItem = nil
    }

    /// Renders the image square at avatar resolution and encodes it as JPEG.
    private static func downscaledJPEG(_ image: UIImage, maxEdge: CGFloat = 512) -> Data? {
        let longest = max(image.size.width, image.size.height)
        let scale = longest > maxEdge ? maxEdge / longest : 1
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return rendered.jpegData(compressionQuality: 0.85)
    }
}

/// Wraps `PhotosPicker` so its label is a plain stored string.
///
/// The picker's label builder is `@Sendable`, so reading main-actor state
/// inside it — which any `Str.…(language)` call does — is a data race the
/// compiler is right to flag. Resolving the text into a stored property moves
/// that read out to the caller, where it is already on the main actor.
private struct ChangePhotoButton: View {
    let title: String
    @Binding var selection: PhotosPickerItem?
    let isDisabled: Bool

    var body: some View {
        PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
            Text(verbatim: title)
                .font(.app(.subheadline, weight: .semibold))
                .foregroundStyle(Theme.Palette.brand)
                .frame(minHeight: Theme.Size.minTouchTarget - 8)
        }
        .disabled(isDisabled)
    }
}
