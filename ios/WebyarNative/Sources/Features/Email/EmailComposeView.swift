import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Writing a mail — new, or answering a thread — with Send in the bar and the
/// paperclip beside it, the way the Android app writes one. Leaving with
/// something written asks first.
///
/// The addresses are laid out left to right in every language — they are
/// addresses — while the subject and the words follow whatever they are
/// written in.
struct EmailComposeView: View {
    let request: EmailComposeRequest
    let inbox: EmailInboxModel

    /// The most a mailbox takes in one mail (`/attachments`), per file.
    static let maximumBytes = 20 * 1024 * 1024
    /// How long a reply waits for the mailbox's own address before it is
    /// addressed without it.
    private static let mailboxWait: TimeInterval = 5

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var model = EmailComposeModel()
    @State private var confirmDiscard = false
    @State private var showsPhotos = false
    @State private var showsFiles = false
    @State private var photoItem: PhotosPickerItem?
    @FocusState private var focus: Field?

    private enum Field: Hashable { case to, cc, bcc, subject, body }

    private var language: Language { appState.language }

    private var title: String {
        switch request.mode {
        case .reply: EmailStr.reply(language)
        case .replyAll: EmailStr.replyAll(language)
        case .forward: EmailStr.forward(language)
        case nil: EmailStr.newMessage(language)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.ready {
                    form
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.Palette.background)
            .overlay(alignment: .bottom) { errorBanner }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
        .interactiveDismissDisabled(model.touched && !model.sent)
        .confirmationDialog(EmailStr.discardDraft(language), isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button(EmailStr.discard(language), role: .destructive) { dismiss() }
            Button(EmailStr.keepEditing(language), role: .cancel) {}
        }
        .photosPicker(isPresented: $showsPhotos, selection: $photoItem, matching: .any(of: [.images, .videos]))
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item]) { result in
            pickedFile(result)
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await pickedPhoto(item) }
        }
        .onChange(of: model.sent) { _, sent in
            guard sent else { return }
            AccessibilityNotification.Announcement(EmailStr.sent(language)).post()
            let answered = request.mode == .forward ? nil : request.sourceThreadID
            Task { [inbox] in await inbox.noteSent(answering: answered) }
            dismiss()
        }
        .onChange(of: language) { _, now in model.language = now }
        .task { await start() }
    }

    // MARK: Pieces

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 0) {
                Text(title)
                    .font(.app(.headline))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                if let address = inbox.address, !address.isEmpty {
                    Text(address)
                        .font(.app(.caption2))
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)
                        .environment(\.layoutDirection, .leftToRight)
                }
            }
        }
        ToolbarItem(placement: .cancellationAction) {
            Button {
                if model.touched && !model.sent { confirmDiscard = true } else { dismiss() }
            } label: {
                Image(systemName: "xmark")
            }
            .accessibilityLabel(Str.cancel(language))
            .accessibilityIdentifier(A11y.emailComposeClose)
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Menu {
                Button {
                    showsPhotos = true
                } label: {
                    Label(EmailStr.photo(language), systemImage: "photo.on.rectangle")
                }
                Button {
                    showsFiles = true
                } label: {
                    Label(EmailStr.file(language), systemImage: "doc")
                }
            } label: {
                Image(systemName: "paperclip")
            }
            .disabled(model.sending || !model.ready)
            .accessibilityLabel(EmailStr.addAttachment(language))
            .accessibilityIdentifier(A11y.emailComposeAttach)

            Button {
                focus = nil
                Task { await model.send() }
            } label: {
                if model.sending {
                    ProgressView()
                } else {
                    Image(systemName: "paperplane.fill")
                        .flipsForRightToLeftLayoutDirection(true)
                }
            }
            .disabled(model.sending || !model.ready)
            .accessibilityLabel(Str.emailSend(language))
            .accessibilityIdentifier(A11y.emailComposeSend)
        }
    }

    private var form: some View {
        @Bindable var model = model
        return ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.sm) {
                VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                    addressField(EmailStr.to(language)) {
                        addressInput($model.fields.to, field: .to)
                            .accessibilityIdentifier(A11y.emailComposeTo)
                    }
                    Text(EmailStr.addressesHint(language))
                        .font(.app(.caption))
                        .foregroundStyle(Theme.Palette.labelTertiary)
                        .padding(.horizontal, Theme.Space.md)
                }
                if model.showCopies {
                    addressField(EmailStr.cc(language)) {
                        addressInput($model.fields.cc, field: .cc)
                            .accessibilityIdentifier(A11y.emailComposeCc)
                    }
                    addressField(EmailStr.bcc(language)) {
                        addressInput($model.fields.bcc, field: .bcc)
                    }
                } else {
                    Button(EmailStr.ccBcc(language)) {
                        withAnimation(Theme.Motion.standard) { model.showCopies = true }
                        focus = .cc
                    }
                    .font(.app(.subheadline, .semibold))
                    .foregroundStyle(Theme.Palette.brand)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.vertical, Theme.Space.xs)
                    .accessibilityIdentifier(A11y.emailComposeCcBcc)
                }
                filled(EmailStr.subject(language)) {
                    TextField("", text: $model.fields.subject)
                        .font(.app(.body))
                        .textInputAutocapitalization(.sentences)
                        .submitLabel(.next)
                        .focused($focus, equals: .subject)
                        .onSubmit { focus = .body }
                        .accessibilityIdentifier(A11y.emailComposeSubject)
                }
                filled(EmailStr.body(language)) {
                    TextField("", text: $model.fields.body, axis: .vertical)
                        .font(.app(.body))
                        .textInputAutocapitalization(.sentences)
                        .lineLimit(8...)
                        .focused($focus, equals: .body)
                        .frame(minHeight: 200, alignment: .top)
                        .accessibilityIdentifier(A11y.emailComposeBody)
                }

                if !model.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Space.sm) {
                        ForEach(model.attachments) { attachment in
                            attachmentChip(attachment)
                        }
                    }
                    .padding(.top, Theme.Space.xs)
                }
            }
            .disabled(model.sending)
            .padding(.horizontal, Theme.screenInset)
            .padding(.vertical, Theme.Space.md)
            // Room under the last field for a problem said at the foot.
            .padding(.bottom, model.error == nil ? 0 : 64)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// A field as the Android app draws one: filled, its name small above
    /// what is typed.
    private func filled(_ label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.app(.caption, .medium))
                .foregroundStyle(Theme.Palette.labelSecondary)
            content()
                .foregroundStyle(Theme.Palette.label)
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Palette.surfaceElevated)
        )
    }

    /// Addresses are laid out left to right in every language.
    private func addressField(_ label: String, @ViewBuilder input: () -> some View) -> some View {
        filled(label, content: input)
            .environment(\.layoutDirection, .leftToRight)
    }

    private func addressInput(_ text: Binding<String>, field: Field) -> some View {
        TextField("", text: text, axis: .vertical)
            .font(.app(.body))
            .keyboardType(.emailAddress)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .lineLimit(1...4)
            .focused($focus, equals: field)
    }

    private func attachmentChip(_ attachment: ComposeAttachment) -> some View {
        HStack(spacing: Theme.Space.sm) {
            if attachment.uploading {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: attachment.failed ? "exclamationmark.triangle.fill" : "doc.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(attachment.failed ? Theme.Palette.danger : Theme.Palette.brand)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(attachment.filename)
                    .font(.app(.subheadline, .medium))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .environment(\.layoutDirection, .leftToRight)
                Text(
                    attachment.failed
                        ? EmailStr.uploadFailed(language)
                        : attachment.uploading
                            ? EmailStr.uploading(language)
                            : Format.fileSize(attachment.sizeBytes, language: language)
                )
                .font(.app(.caption))
                .foregroundStyle(attachment.failed ? Theme.Palette.danger : Theme.Palette.labelTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                model.removeAttachment(attachment.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(EmailStr.removeAttachment(language))
        }
        .padding(.leading, Theme.Space.md)
        .padding(.trailing, Theme.Space.xxs)
        .padding(.vertical, Theme.Space.xxs)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(attachment.failed ? Theme.Palette.danger.opacity(0.12) : Theme.Palette.surfaceElevated)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.emailComposeAttachment)
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = model.error {
            HStack(spacing: Theme.Space.sm) {
                Text(error)
                    .font(.app(.subheadline))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(Str.cancel(language)) { model.error = nil }
                    .font(.app(.subheadline, .semibold))
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, Theme.Space.lg)
            .padding(.vertical, Theme.Space.md)
            .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Color.black.opacity(0.82)))
            .padding(.horizontal, Theme.screenInset)
            .padding(.bottom, Theme.Space.md)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityIdentifier(A11y.emailComposeError)
        }
    }

    // MARK: Starting

    /// A reply is prefilled once, and the workspace's own address is what it
    /// leaves out of To and Cc. Opened before the mailbox is known — a thread
    /// opened from a notification, or Reply all tapped the moment the thread
    /// opens — it waits a moment for the address; one that never comes (a
    /// request that fails) is prefilled without it.
    private func start() async {
        model.language = language
        guard let workspaceID = appState.selectedWorkspace?.id else { return }
        let provider = request.provider ?? inbox.provider
        Task { [inbox] in await inbox.bind(workspaceID, provider: provider) }
        let answers = request.sourceThreadID != nil && (request.mode == .reply || request.mode == .replyAll)
        if answers, inbox.address == nil {
            let deadline = Date().addingTimeInterval(Self.mailboxWait)
            while inbox.address == nil, Date() < deadline, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        await model.start(
            workspaceID: workspaceID,
            sourceThreadID: request.sourceThreadID,
            mode: request.mode,
            mailbox: inbox.address,
            provider: provider
        )
        if model.ready, request.mode == nil || request.mode == .forward { focus = .to }
    }

    // MARK: Picking

    private func pickedPhoto(_ item: PhotosPickerItem) async {
        defer { photoItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            model.error = Str.attachmentFailed(language)
            return
        }
        guard data.count <= Self.maximumBytes else {
            model.error = EmailStr.fileTooLarge(language)
            return
        }
        // What the picker hands over, which is not always what is in the
        // library — a HEIC photo transcodes on the way out.
        let type = item.supportedContentTypes.first
        let ext = type?.preferredFilenameExtension ?? "jpg"
        let mime = type?.preferredMIMEType ?? "image/jpeg"
        let isVideo = type?.conforms(to: .movie) == true
        await model.attach(data: data, filename: "\(isVideo ? "video" : "photo").\(ext)", contentType: mime)
    }

    private func pickedFile(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        // A file from another app arrives outside the sandbox; it is read
        // inside a security scope or it comes back empty.
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > Self.maximumBytes {
            model.error = EmailStr.fileTooLarge(language)
            return
        }
        guard let data = try? Data(contentsOf: url) else {
            model.error = Str.attachmentFailed(language)
            return
        }
        guard data.count <= Self.maximumBytes else {
            model.error = EmailStr.fileTooLarge(language)
            return
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        Task { await model.attach(data: data, filename: url.lastPathComponent, contentType: mime) }
    }
}
