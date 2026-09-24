import SwiftUI
import UniformTypeIdentifiers

/// The detail column: the open thread with its subject and actions over it,
/// and the reply box under it — or a quiet placeholder.
struct EmailDetail: View {
    let model: EmailModel
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let s = app.strings
        Group {
            if model.selectedId == nil {
                EmptyState(systemImage: "envelope.open", title: s["noEmailSelected"], message: s["noEmailSelectedBody"])
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                thread
            }
        }
        .background(Palette.chatBackground)
        .sheet(isPresented: Binding(get: { model.composing }, set: { model.composing = $0 })) {
            EmailComposeSheet(model: model)
                .environment(app)
                .appEnvironment(app)
        }
    }

    private var thread: some View {
        let s = app.strings
        return ZStack {
            if let d = model.detail {
                MailWebView(html: EmailHTML.page(d, dark: scheme == .dark, s: s)) { id in
                    if let a = (d.messages ?? []).flatMap({ $0.attachments ?? [] }).first(where: { $0.id == id }) {
                        model.openAttachment(a)
                    }
                }
            } else if let error = model.detailError {
                EmptyState(systemImage: "exclamationmark.triangle", title: error, tint: Palette.warning)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                EmailHeader(model: model)
                if let n = model.notice {
                    Banner(severity: n.severity, message: n.message, onClose: { model.notice = nil })
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.detail != nil {
                EmailReplyBox(model: model)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
                    .padding(.top, 6)
            }
        }
    }
}

/// Subject, participants and what can be done with the thread.
struct EmailHeader: View {
    let model: EmailModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let t = model.selected
        let count = model.detail?.messages?.count ?? 0
        HStack(spacing: 12) {
            Image(systemName: "envelope.fill")
                .font(.system(size: 15))
                .foregroundStyle(Palette.brand)
                .frame(width: 38, height: 38)
                .background(Palette.brandSoft, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(subject(t)).appFont(14.5, .bold).lineLimit(2)
                HStack(spacing: 6) {
                    if count > 1 { Chip(text: s.get("emailMessages", "count", count)) }
                    Text((t?.participants ?? []).map(\.display).joined(separator: ", "))
                        .appFont(11.5).foregroundStyle(Palette.text2).lineLimit(1)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            if let t {
                GlassGroup(spacing: 6) {
                    HStack(spacing: 6) {
                        circle(t.starred ? "star.fill" : "star", s[t.starred ? "emailUnstar" : "emailStar"], tint: t.starred ? .yellow : nil) { model.toggleStar(t.id) }
                        circle("envelope.badge", s["emailMarkUnread"]) { model.setRead(t.id, false) }
                        circle("arrowshape.turn.up.left", s["emailReply"]) { model.replyMode = .reply }
                        circle("arrowshape.turn.up.left.2", s["emailReplyAll"]) { model.replyMode = .replyAll }
                        circle("arrowshape.turn.up.right", s["emailForward"]) { model.replyMode = .forward }
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .glassCard(18)
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private func subject(_ t: EmailThreadSummary?) -> String {
        let v = (t?.subject ?? "").trimmingCharacters(in: .whitespaces)
        return v.isEmpty ? app.strings["emailNoSubject"] : v
    }

    private func circle(_ icon: String, _ help: String, tint: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).frame(width: 18, height: 18).foregroundStyle(tint ?? Palette.text)
        }
        .glassButton()
        .buttonBorderShape(.circle)
        .help(help)
    }
}

/// The reply box under a thread: reply, reply all or forward; the recipients
/// (editable), Cc and Bcc on request, the text, files, and Send (⌘↩).
struct EmailReplyBox: View {
    let model: EmailModel
    @Environment(AppModel.self) private var app
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var showCopies = false
    @State private var picking = false
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Picker("", selection: $model.replyMode) {
                    Label(s["emailReply"], systemImage: "arrowshape.turn.up.left").tag(ReplyMode.reply)
                    Label(s["emailReplyAll"], systemImage: "arrowshape.turn.up.left.2").tag(ReplyMode.replyAll)
                    Label(s["emailForward"], systemImage: "arrowshape.turn.up.right").tag(ReplyMode.forward)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                Spacer(minLength: 6)
                Button(showCopies ? s["emailHideCopies"] : "Cc / Bcc") { withAnimation(.smooth) { showCopies.toggle() } }
                    .buttonStyle(.link)
                    .appFont(12)
            }
            addressRow(s["emailTo"], $to)
            if showCopies {
                addressRow("Cc", $cc)
                addressRow("Bcc", $bcc)
            }
            Divider()
            TextField(model.replyMode == .forward ? s["emailForwardPlaceholder"] : s["emailReplyPlaceholder"], text: $model.replyText, axis: .vertical)
                .textFieldStyle(.plain)
                .appFont(13.5)
                .lineLimit(3...10)
                .focused($focused)
            if !model.replyAttachments.isEmpty {
                AttachmentStrip(items: model.replyAttachments) { id in model.replyAttachments.removeAll { $0.id == id } }
            }
            HStack(spacing: 8) {
                Button { picking = true } label: { Image(systemName: "paperclip").font(.system(size: 14)) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Palette.text2)
                    .help(s["attachFile"])
                if model.replyMode == .forward {
                    Label(s["emailForwardIncludes"], systemImage: "text.quote").appFont(11).foregroundStyle(Palette.text3)
                }
                Spacer()
                Text("⌘↩").appFont(11).foregroundStyle(Palette.text3)
                Button(action: send) {
                    HStack(spacing: 6) {
                        if model.sending { ProgressView().controlSize(.small).tint(.white) }
                        Text(s["emailSend"]).appFont(13, .semibold)
                        Image(systemName: "paperplane.fill").font(.system(size: 11)).scaleEffect(x: s.isRightToLeft ? -1 : 1)
                    }
                }
                .prominentButton()
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
            }
        }
        .padding(14)
        .glassCard(20)
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(focused ? Palette.brand.opacity(0.55) : .clear, lineWidth: 1.2))
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { urls.forEach { model.stageReply($0) } }
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { Task { @MainActor in model.stageReply(url) } }
                }
            }
            return true
        }
        .onAppear(perform: fill)
        .onChange(of: model.replyMode) { _, _ in fill() }
        .onChange(of: model.detail?.messages?.count) { _, _ in fill() }
    }

    private func addressRow(_ label: String, _ text: Binding<String>) -> some View {
        HStack(spacing: 8) {
            Text(label).appFont(12, .semibold).foregroundStyle(Palette.text2).frame(minWidth: 44, alignment: .leading)
            TextField("name@company.com", text: text)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .environment(\.layoutDirection, .leftToRight)
        }
    }

    /// Recipients follow the mode, as every mail app does.
    private func fill() {
        let r = model.replyRecipients(model.replyMode)
        to = r.to.map(\.email).joined(separator: ", ")
        cc = r.cc.map(\.email).joined(separator: ", ")
        bcc = ""
        if !r.cc.isEmpty { showCopies = true }
    }

    private var recipients: (to: [EmailAddress], cc: [EmailAddress], bcc: [EmailAddress]) {
        (EmailAddress.parse(to), EmailAddress.parse(cc), EmailAddress.parse(bcc))
    }

    private var canSend: Bool {
        let r = recipients
        let all = r.to + r.cc + r.bcc
        return !model.sending && !r.to.isEmpty && all.allSatisfy(\.isValid)
            && !model.replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && model.replyAttachments.allSatisfy { $0.staged != nil }
    }

    private func send() {
        guard canSend else { return }
        let r = recipients
        model.sendReply(to: r.to, cc: r.cc, bcc: r.bcc)
    }
}

/// Files on their way out: a chip each, spinning until uploaded.
struct AttachmentStrip: View {
    let items: [OutgoingAttachment]
    let remove: (UUID) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(items) { a in
                HStack(spacing: 6) {
                    if a.failed {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.danger)
                    } else if a.staged == nil {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: a.mime.hasPrefix("image/") ? "photo" : "doc").foregroundStyle(Palette.brand)
                    }
                    Text(a.name).appFont(11.5, .semibold).lineLimit(1).truncationMode(.middle).frame(maxWidth: 180)
                    Text(Display.fileSize(a.size, app.strings)).appFont(10.5).foregroundStyle(Palette.text3)
                    Button { remove(a.id) } label: { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Palette.text3)
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Palette.surface2, in: Capsule())
                .overlay(Capsule().strokeBorder(a.failed ? Palette.danger : Palette.line, lineWidth: 1))
            }
        }
    }
}

/// A new email: To, Cc/Bcc, subject, text and files.
struct EmailComposeSheet: View {
    let model: EmailModel
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var subject = ""
    @State private var text = ""
    @State private var showCopies = false
    @State private var files: [OutgoingAttachment] = []
    @State private var picking = false
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        let s = app.strings
        VStack(spacing: 0) {
            HStack {
                Label(s["newEmail"], systemImage: "square.and.pencil").appFont(15, .bold)
                Spacer()
                if let from = model.connection?.emailAddress {
                    Text("\(s["emailFrom"]): \(from)").appFont(11.5).foregroundStyle(Palette.text2)
                }
            }
            .padding(16)
            Divider()
            VStack(spacing: 0) {
                field(s["emailTo"], $to, ltr: true) {
                    Button(showCopies ? s["emailHideCopies"] : "Cc / Bcc") { withAnimation(.smooth) { showCopies.toggle() } }
                        .buttonStyle(.link).appFont(12)
                }
                if showCopies {
                    field("Cc", $cc, ltr: true) { EmptyView() }
                    field("Bcc", $bcc, ltr: true) { EmptyView() }
                }
                field(s["emailSubject"], $subject, ltr: false) { EmptyView() }
            }
            TextEditor(text: $text)
                .font(Typeface.font(13.5))
                .scrollContentBackground(.hidden)
                .padding(12)
                .frame(minHeight: 240)
            if !files.isEmpty {
                AttachmentStrip(items: files) { id in files.removeAll { $0.id == id } }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error {
                Banner(severity: .error, message: error, onClose: { self.error = nil }).padding(.horizontal, 16).padding(.bottom, 8)
            }
            Divider()
            HStack(spacing: 10) {
                Button { picking = true } label: { Label(s["attachFile"], systemImage: "paperclip") }
                    .buttonStyle(.borderless)
                Spacer()
                Button(s["cancel"]) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(action: send) {
                    HStack(spacing: 6) {
                        if sending { ProgressView().controlSize(.small).tint(.white) }
                        Text(s["emailSend"]).appFont(13, .semibold)
                    }
                }
                .prominentButton()
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
            }
            .padding(14)
        }
        .frame(width: 640)
        .frame(minHeight: 520)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { urls.forEach(stage) }
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { Task { @MainActor in stage(url) } }
                }
            }
            return true
        }
    }

    private func field<Accessory: View>(_ label: String, _ text: Binding<String>, ltr: Bool, @ViewBuilder accessory: () -> Accessory) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(label).appFont(12.5, .semibold).foregroundStyle(Palette.text2).frame(minWidth: 56, alignment: .leading)
                TextField("", text: text)
                    .textFieldStyle(.plain)
                    .appFont(13)
                    .environment(\.layoutDirection, ltr ? .leftToRight : (app.strings.isRightToLeft ? .rightToLeft : .leftToRight))
                accessory()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider().padding(.leading, 16)
        }
    }

    private func stage(_ url: URL) {
        model.stage(url) { item, replacing in
            guard let item else { return }
            if let replacing, let i = files.firstIndex(where: { $0.id == replacing }) { files[i] = item } else if replacing == nil { files.append(item) }
        }
    }

    private var canSend: Bool {
        let all = EmailAddress.parse(to) + EmailAddress.parse(cc) + EmailAddress.parse(bcc)
        return !sending && !EmailAddress.parse(to).isEmpty && all.allSatisfy(\.isValid)
            && !subject.trimmingCharacters(in: .whitespaces).isEmpty
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && files.allSatisfy { $0.staged != nil }
    }

    private func send() {
        guard canSend else { return }
        sending = true
        error = nil
        Task {
            let failure = await model.sendNew(to: EmailAddress.parse(to), cc: EmailAddress.parse(cc), bcc: EmailAddress.parse(bcc),
                                              subject: subject.trimmingCharacters(in: .whitespaces),
                                              body: text.trimmingCharacters(in: .whitespacesAndNewlines),
                                              attachments: files.compactMap(\.staged))
            sending = false
            if let failure { error = failure } else { dismiss() }
        }
    }
}
