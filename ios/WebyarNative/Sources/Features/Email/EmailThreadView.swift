import SwiftUI
import QuickLook
import WebKit

/// One email thread, read the way the Android and Windows apps read it.
///
/// The whole thread is one white page (`EmailReader`): the subject, the
/// newest mail open under who sent it, when and to whom, and the earlier ones
/// folded below it, each a line that opens with a tap. A mail is shown as it
/// was written — its own layout, colours, pictures and tables — rather than as
/// its words with the HTML taken out. Files are chips on the page that open
/// in Quick Look; links go to the browser. At the foot, Reply, Reply all and
/// Forward, which open the composer already addressed.
struct EmailThreadView: View {
    let ref: EmailThreadRef
    /// The workspace's mailbox, which outlives this screen: the row's star
    /// and read state follow from here, and a thread read once is kept there.
    let inbox: EmailInboxModel

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var model = EmailThreadModel()
    /// The page, built off the main thread from what the model holds.
    @State private var page: String?
    @State private var drawn = false
    /// A file of the mail on its way to be opened; a second tap waits for it.
    @State private var downloading = false
    @State private var preview: URL?
    @State private var notice: String?
    @State private var composing: EmailComposeRequest?
    /// Fixed when the screen opens: the list switching mailbox underneath
    /// does not move a thread out of its own.
    @State private var provider: String?
    @State private var providerFixed = false

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    private var pageKey: PageKey {
        PageKey(
            messages: model.messages,
            subject: model.thread?.subject,
            snippet: model.thread?.lastMessageSnippet,
            mailbox: inbox.address,
            language: language
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if case .loaded = model.state {
                replyBar
            }
        }
        .background(Theme.Palette.background)
        .overlay(alignment: .bottom) { banners }
        .navigationTitle(Str.emailInbox(language))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .quickLookPreview($preview)
        // Held on disk while Quick Look shows it; let go when it closes.
        .onChange(of: preview) { old, new in
            if let old { Task { await AttachmentDiskCache.shared.unpin(old) } }
            if let new { Task { await AttachmentDiskCache.shared.pin(new) } }
        }
        .task(id: "\(workspaceID ?? "-")|\(ref.id)|\(ref.folder ?? "-")") { await open() }
        .task(id: pageKey) { await buildPage() }
        .onAppear {
            PushController.shared.viewingEmailThread = ref.id
            if let workspaceID {
                PushController.clearDelivered(.email(workspaceID: workspaceID, threadID: ref.id))
            }
            // A change made while it was behind another screen — a reply
            // just sent from the composer — is read now.
            if inbox.consumeStale(ref.id) { Task { await model.reloadQuietly() } }
        }
        .onDisappear {
            guard PushController.shared.viewingEmailThread == ref.id else { return }
            PushController.shared.viewingEmailThread = nil
        }
        // New mail in this thread while it is open: read again, in place.
        .onChange(of: inbox.threadChange) { _, change in
            guard change.threads?.contains(ref.id) ?? true else { return }
            _ = inbox.consumeStale(ref.id)
            Task { await model.reloadQuietly() }
        }
        .onChange(of: language) { _, now in model.language = now }
        .mailSentNotice(inbox.sentCount, language: language)
        .sheet(item: $composing) { request in
            EmailComposeView(request: request, inbox: inbox)
        }
    }

    // MARK: Pieces

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            MailLoading(text: EmailStr.openingMail(language))

        case .failed(let message):
            ErrorStateView(
                title: Str.offlineTitle(language),
                message: message,
                retryTitle: Str.retry(language),
                onRetry: { Task { await model.retry() } }
            )

        case .loaded:
            ZStack {
                if let page {
                    EmailWebView(
                        document: page,
                        drawn: $drawn,
                        onAttachment: { id in openAttachment(id) },
                        loadInline: { id in await inlinePart(id) }
                    )
                    .accessibilityIdentifier(A11y.emailThread)
                }
                // A long mail takes a moment to lay out after it arrives: the
                // loader stays until the page is drawn, on the page's own
                // white, so nothing flashes behind it.
                if page == nil || !drawn {
                    Color.white
                        .overlay { ProgressView().tint(.gray) }
                        .accessibilityHidden(true)
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            // The star where it is seen, in the bar, rather than in a menu:
            // it is the one thing done to nearly every mail.
            let starred = model.isStarred
            Button {
                inbox.setStarredLocally(ref.id, starred: !starred)
                Task { await model.toggleStar() }
            } label: {
                Image(systemName: starred ? "star.fill" : "star")
                    .foregroundStyle(starred ? Theme.Palette.warning : Theme.Palette.brand)
            }
            .disabled(model.thread == nil)
            .accessibilityLabel(starred ? EmailStr.unstar(language) : EmailStr.star(language))
            .accessibilityIdentifier(A11y.emailThreadStar)

            Menu {
                Button {
                    // Said by the mailbox's model, which outlives this screen:
                    // the request is not cancelled by the dismiss below.
                    let id = ref.id
                    Task { await inbox.setRead(id, read: false) }
                    // The copy kept on the phone says read; it no longer is.
                    inbox.noteChanged(id)
                    // And back out: the thread just marked unread is one the
                    // operator is done with — staying would mark it read
                    // again the moment anything reloaded.
                    dismiss()
                } label: {
                    Label(Str.emailMarkUnread(language), systemImage: "envelope.badge")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel(EmailStr.moreOptions(language))
            .accessibilityIdentifier(A11y.emailMenu)
        }
    }

    /// Reply, Reply all, Forward — the three ways a mail is answered.
    private var replyBar: some View {
        HStack(spacing: Theme.Space.sm) {
            replyButton(EmailStr.reply(language), icon: "arrowshape.turn.up.left", prominent: true, mode: .reply)
                .accessibilityIdentifier(A11y.emailReply)
            replyButton(EmailStr.replyAll(language), icon: "arrowshape.turn.up.left.2", prominent: false, mode: .replyAll)
                .accessibilityIdentifier(A11y.emailReplyAll)
            replyButton(EmailStr.forward(language), icon: "arrowshape.turn.up.right", prominent: false, mode: .forward)
                .accessibilityIdentifier(A11y.emailForward)
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.sm)
        .background(.bar)
    }

    private func replyButton(_ title: String, icon: String, prominent: Bool, mode: EmailReplyMode) -> some View {
        Button {
            composing = EmailComposeRequest(sourceThreadID: ref.id, mode: mode, provider: provider)
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                    // Mirrored with the language: «reply» points back to
                    // where the reader came from.
                    .flipsForRightToLeftLayoutDirection(true)
                Text(title)
                    .font(.app(.subheadline, .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .foregroundStyle(Theme.Palette.brand)
            .background {
                if prominent {
                    Capsule().fill(Theme.Palette.brand.opacity(0.14))
                } else {
                    Capsule().strokeBorder(Theme.Palette.separator, lineWidth: 1)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    /// The file on its way, said at once rather than only once it opens; and
    /// what went wrong, when something did.
    @ViewBuilder
    private var banners: some View {
        VStack(spacing: Theme.Space.sm) {
            if downloading {
                HStack(spacing: Theme.Space.sm) {
                    ProgressView()
                        .tint(.white)
                    Text(EmailStr.downloadingFile(language))
                        .font(.app(.subheadline))
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, Theme.Space.lg)
                .padding(.vertical, Theme.Space.sm)
                .background(Capsule().fill(Color.black.opacity(0.82)))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(A11y.emailDownloading)
            }
            if let notice {
                HStack(spacing: Theme.Space.sm) {
                    Text(notice)
                        .font(.app(.subheadline))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(Str.cancel(language)) { self.notice = nil }
                        .font(.app(.subheadline, .semibold))
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, Theme.Space.lg)
                .padding(.vertical, Theme.Space.md)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous).fill(Color.black.opacity(0.82)))
                .padding(.horizontal, Theme.screenInset)
            }
        }
        .padding(.bottom, 72)
        .animation(Theme.Motion.standard, value: downloading)
        .animation(Theme.Motion.standard, value: notice)
    }

    // MARK: Loading

    private func open() async {
        model.language = language
        model.onUnauthorized = { [appState] in await appState.handleUnauthorized() }
        guard let workspaceID else { return }
        if !providerFixed {
            provider = ref.provider ?? inbox.provider
            providerFixed = true
        }
        let provider = provider
        let folder = ref.folder
        // The mailbox's model bound here too, not only by its list: a thread
        // opened from a notification is on screen with the list never shown
        // beneath it, and then nothing would learn the workspace's own
        // address — which is what keeps a Reply all from copying it back in.
        // Not awaited, and not this screen's to cancel: the list loads on.
        Task { await inbox.bind(workspaceID, provider: provider) }
        let known = inbox.thread(ref.id)
        inbox.markReadLocally(ref.id)
        await model.open(
            workspaceID: workspaceID,
            threadID: ref.id,
            known: known,
            mailbox: provider,
            // Unchanged since this phone last read it: no request.
            cached: inbox.cachedThread(ref.id, provider: provider, version: known?.version, folder: folder),
            folder: folder,
            remember: { [inbox] response in inbox.rememberThread(response, provider: provider, folder: folder) }
        )
    }

    private func buildPage() async {
        guard case .loaded = model.state else { return }
        let key = pageKey
        // A long mail's markup is cut down and rewritten by regular
        // expressions: off the main thread, so the screen keeps moving.
        let built = await Task.detached(priority: .userInitiated) {
            EmailReader.document(
                subject: key.subject,
                messages: key.messages,
                mailbox: key.mailbox,
                language: key.language,
                snippet: key.snippet
            )
        }.value
        guard !Task.isCancelled else { return }
        if built != page {
            drawn = false
            page = built
        }
    }

    // MARK: Files

    private func attachment(_ id: String) -> EmailAttachmentView? {
        for message in model.messages {
            if let found = message.attachments?.first(where: { $0.id == id }) { return found }
        }
        return nil
    }

    /// The file on this phone's disk, downloaded the first time.
    private static func fileURL(_ file: EmailAttachmentView, workspaceID: String, provider: String?) async throws -> URL {
        let api: any EmailAPI = Backend.current
        return try await AttachmentStore.shared.mailFileURL(
            id: file.id,
            fileExtension: EmailReader.fileExtension(file)
        ) {
            try await api.emailAttachmentData(workspaceID: workspaceID, attachmentID: file.id, mailbox: provider)
        }
    }

    private func openAttachment(_ id: String) {
        guard !downloading, let file = attachment(id), let workspaceID else { return }
        downloading = true
        notice = nil
        let provider = provider
        Task {
            defer { downloading = false }
            do {
                preview = try await Self.fileURL(file, workspaceID: workspaceID, provider: provider)
            } catch {
                notice = EmailStr.downloadFailed(language)
            }
        }
    }

    /// A picture drawn inside the mail (`cid:`), for the page. Nothing for a
    /// very large one, or one that does not come in time: the page draws on
    /// without it rather than waiting.
    private func inlinePart(_ id: String) async -> MailPart? {
        guard let file = attachment(id), (file.sizeBytes ?? 0) <= EmailReader.inlinePictureMaxBytes,
              let workspaceID else { return nil }
        let provider = provider
        let url: URL? = await withTaskGroup(of: URL?.self) { group in
            group.addTask { try? await Self.fileURL(file, workspaceID: workspaceID, provider: provider) }
            group.addTask {
                try? await Task.sleep(nanoseconds: EmailReader.inlinePictureWait)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        guard let url else { return nil }
        let data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: url) }.value
        guard let data, !data.isEmpty else { return nil }
        let type = file.contentType.flatMap { $0.lowercased().hasPrefix("image/") ? $0 : nil } ?? "application/octet-stream"
        return MailPart(mimeType: type, data: data)
    }
}

/// What the page is made from: rebuilt only when one of these changes.
private struct PageKey: Equatable {
    let messages: [EmailMessageView]
    let subject: String?
    let snippet: String?
    let mailbox: String?
    let language: Language
}

/// One part of a mail the page asked for: its type and its bytes.
struct MailPart: Sendable {
    let mimeType: String
    let data: Data
}

// MARK: - The page

/// The page, in a web view that can only draw.
///
/// JavaScript is off, nothing is stored (no cookies, no caches kept), no
/// second window can open, and nothing navigates inside it: a tapped link is
/// handed to the system (or, for a file chip, to the app), and a navigation
/// nobody tapped — a mail trying to move the page by itself — goes nowhere.
/// Inline pictures come through the app's own scheme, from the signed-in API.
struct EmailWebView: UIViewRepresentable {
    let document: String
    @Binding var drawn: Bool
    let onAttachment: (String) -> Void
    let loadInline: @MainActor (String) async -> MailPart?

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.websiteDataStore = .nonPersistent()
        configuration.dataDetectorTypes = []
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.setURLSchemeHandler(context.coordinator.parts, forURLScheme: EmailReader.inlineScheme)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        // White before the first frame too, so a dark theme does not flash
        // black behind a mail that is about to be white.
        view.isOpaque = false
        view.backgroundColor = .white
        view.scrollView.backgroundColor = .white
        view.scrollView.contentInsetAdjustmentBehavior = .automatic
        // A long press would load the link in a preview, inside the app.
        view.allowsLinkPreview = false
        // On the web view itself too: SwiftUI's modifier on a representable
        // does not always reach the view UI tests see.
        view.accessibilityIdentifier = A11y.emailThread
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        // Only a new page is loaded: anything else would throw away the
        // reader's scroll and every card they opened.
        guard context.coordinator.loaded != document else { return }
        context.coordinator.loaded = document
        view.loadHTMLString(document, baseURL: nil)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        coordinator.parts.stopAll()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: EmailWebView
        var loaded: String?
        let parts: MailPartHandler

        init(_ parent: EmailWebView) {
            self.parent = parent
            parts = MailPartHandler()
            super.init()
            parts.load = { [weak self] id in await self?.parent.loadInline(id) }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            let link = url.absoluteString
            // The page itself, as the app loads it.
            if navigationAction.navigationType == .other, link == "about:blank" {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            guard navigationAction.navigationType == .linkActivated else {
                // A page that moves by itself (a refresh, a redirect) is
                // simply stopped.
                return
            }
            if let id = EmailReader.attachmentID(of: link), link.hasPrefix("\(EmailReader.attachmentScheme):") {
                parent.onAttachment(id)
                return
            }
            // Only a link somebody tapped leaves the app.
            if let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) {
                UIApplication.shared.open(url)
            }
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            parent.drawn = true
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.drawn = true
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.drawn = true
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.drawn = true
        }

        /// A crashed renderer takes the page with it, not the app: drawn again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard let loaded else { return }
            webView.loadHTMLString(loaded, baseURL: nil)
        }
    }
}

/// Answers the page's `webyar-inline://part/<id>` requests with the mail's
/// own pictures. A request the page gave up on (it was closed, or scrolled
/// away) is never answered: WebKit does not allow it.
@MainActor
final class MailPartHandler: NSObject, WKURLSchemeHandler {
    var load: (@MainActor (String) async -> MailPart?)?
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url,
              let id = EmailReader.attachmentID(of: url.absoluteString),
              let load
        else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        running[key] = Task { [weak self] in
            let part = await load(id)
            // Stopped meanwhile: not to be touched again.
            guard let self, self.running.removeValue(forKey: key) != nil else { return }
            guard let part else {
                urlSchemeTask.didFailWithError(URLError(.resourceUnavailable))
                return
            }
            urlSchemeTask.didReceive(URLResponse(
                url: url, mimeType: part.mimeType, expectedContentLength: part.data.count, textEncodingName: nil
            ))
            urlSchemeTask.didReceive(part.data)
            urlSchemeTask.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }

    func stopAll() {
        for task in running.values { task.cancel() }
        running = [:]
    }
}
