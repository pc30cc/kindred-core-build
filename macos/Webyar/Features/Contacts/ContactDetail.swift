import AppKit
import SwiftUI

/// The chosen contact as a profile — a header with who they are, how to
/// reach them and the numbers that matter, then Overview, Conversations,
/// Calls and Notes, as the Windows app and the web's ContactDetailPage show it.
struct ContactDetail: View {
    let model: ContactsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if let item = model.shown, let contact = model.detail {
                ContactProfileView(model: model, item: item, contact: contact)
                    .id(item.id)
            } else {
                placeholder
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.appBackground)
    }

    private var placeholder: some View {
        VStack(spacing: 10) {
            Image(systemName: "person.crop.rectangle")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(Palette.brand)
                .frame(width: 72, height: 72)
                .background(Palette.brandSoft, in: RoundedRectangle(cornerRadius: 19, style: .continuous))
            Text(app.strings["noContactSelected"]).appFont(16, .semibold)
        }
    }
}

// MARK: - Profile

struct ContactProfileView: View {
    let model: ContactsModel
    let item: ContactItem
    let contact: Contact
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ContactHeaderCard(model: model, item: item, contact: contact)
                Picker("", selection: $model.tab) {
                    Text(s["contactOverview"]).tag(ContactTab.overview)
                    Text(s["contactConversations"]).tag(ContactTab.chats)
                    Text(s["contactCalls"]).tag(ContactTab.calls)
                    Text(s["contactNotes"]).tag(ContactTab.notes)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                if model.detailLoading {
                    ProgressView().controlSize(.regular).frame(maxWidth: .infinity).padding(.vertical, 24)
                }
                tabContent
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 24)
            .frame(maxWidth: 980)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var tabContent: some View {
        switch model.tab {
        case .overview: ContactOverviewCard(item: item, contact: contact)
        case .chats: ContactChatsPanel(model: model)
        case .calls: ContactCallsPanel(model: model)
        case .notes: ContactNotesCard(contact: contact)
        }
    }
}

// MARK: - Header: who, how to reach them, and the numbers

struct ContactHeaderCard: View {
    let model: ContactsModel
    let item: ContactItem
    let contact: Contact
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            identity
            stats
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 20)
        .panel(12)
    }

    private var subtitle: String {
        [contact.company, contact.email, contact.phone]
            .compactMap { $0 }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .joined(separator: " · ")
    }

    private var identity: some View {
        let s = app.strings
        let tags: [String] = Array((contact.tags ?? []).prefix(4))
        return HStack(alignment: .center, spacing: 18) {
            AvatarView(name: item.name, email: contact.email, os: item.os, countryCode: item.countryCode,
                       imageURL: contact.avatarUrl, size: 76, faceless: true)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: item.name).appFont(22, .bold).fixedSize(horizontal: false, vertical: true)
                if !subtitle.isEmpty {
                    Text(verbatim: subtitle).appFont(13).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if !tags.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(tags, id: \.self) { tag in
                            Chip(text: tag, foreground: Palette.brand, background: Palette.brandSoft)
                        }
                    }
                    .padding(.top, 4)
                }
            }
            Spacer(minLength: 8)
            actions(s)
        }
    }

    private func actions(_ s: Strings) -> some View {
        HStack(spacing: 8) {
            if let email = contact.email, !email.trimmingCharacters(in: .whitespaces).isEmpty {
                Button { ContactActions.sendEmail(email) } label: {
                    Label(s["contactSendEmail"], systemImage: "envelope")
                }
                .glassButton()
                .controlSize(.large)
            }
            Button { model.openLatest() } label: {
                Label(s["ccOpenConversation"], systemImage: "bubble.left.and.bubble.right")
            }
            .prominentButton()
            .controlSize(.large)
            .disabled((model.chats ?? []).isEmpty)
        }
    }

    private var stats: some View {
        let s = app.strings
        let chats: String = model.chats.map { s.number($0.count) } ?? "—"
        let calls: String = model.calls.map { s.number($0.count) } ?? "—"
        let first: String = contact.createdAt.map { Display.shortDate($0, s.language) } ?? "—"
        let updated: String = (contact.updatedAt ?? contact.createdAt).map { Display.listStamp($0, s) } ?? "—"
        return HStack(spacing: 10) {
            ContactStat(value: chats, label: s["contactConversations"], valueSize: 18, foreground: Palette.brand, background: Palette.brandSoft)
            ContactStat(value: calls, label: s["contactCalls"], valueSize: 18, foreground: Palette.success, background: Palette.successSoft)
            ContactStat(value: first, label: s["firstSeen"], valueSize: 14, foreground: Palette.ai, background: Palette.aiSoft)
            ContactStat(value: updated, label: s["contactUpdated"], valueSize: 14, foreground: Palette.text, background: Palette.elevated)
        }
    }
}

struct ContactStat: View {
    let value: String
    let label: String
    let valueSize: CGFloat
    let foreground: Color
    let background: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: value).appFont(valueSize, .bold).foregroundStyle(foreground).lineLimit(1).truncationMode(.tail)
            Text(label).appFont(11.5).foregroundStyle(Palette.text3).lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - Overview

struct ContactOverviewCard: View {
    let item: ContactItem
    let contact: Contact
    @Environment(AppModel.self) private var app

    private struct Fact: Identifiable {
        let id: String
        let icon: String
        let label: String
        let value: String
        var copy = false
        var ltr = false
    }

    private var facts: [Fact] {
        let s = app.strings
        let geo = item.profile?.geo
        let device = item.profile?.device
        let region: String? = geo?.region != geo?.city ? geo?.region : nil
        let place = [geo?.city, region, geo?.country]
            .compactMap { $0 }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .joined(separator: s.isRightToLeft ? "، " : ", ")
        let deviceText = [device?.browser, device?.os, Self.deviceLabel(device?.device, s)]
            .compactMap { $0 }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .joined(separator: " · ")
        let candidates: [(String, String, String, String?, Bool, Bool)] = [
            ("email", "envelope", s["emailLabel"], contact.email, true, true),
            ("phone", "phone", s["phoneLabel"], contact.phone, true, true),
            ("company", "building.2", s["contactCompany"], contact.company, false, false),
            ("location", "mappin.and.ellipse", s["visitorLocation"], place.isEmpty ? nil : place, false, false),
            ("device", "desktopcomputer", s["visitorDevice"], deviceText.isEmpty ? nil : deviceText, false, true),
            ("code", "number", s["contactVisitorCode"], contact.visitorCode ?? contact.metaString("anon_code"), true, true),
            ("first", "calendar", s["firstSeen"], contact.createdAt.map { Self.longDate($0, s) }, false, false),
            ("updated", "clock.arrow.circlepath", s["contactUpdated"], contact.updatedAt.map { Self.longDate($0, s) }, false, false),
        ]
        var out: [Fact] = []
        for c in candidates {
            guard let v = c.3, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            out.append(Fact(id: c.0, icon: c.1, label: c.2, value: v, copy: c.4, ltr: c.5))
        }
        return out
    }

    var body: some View {
        let list = facts
        VStack(spacing: 0) {
            if list.isEmpty {
                ContactEmptyNote(systemImage: "person.text.rectangle", text: app.strings["contactNoNotes"])
            } else {
                ForEach(Array(list.enumerated()), id: \.element.id) { index, fact in
                    if index > 0 {
                        Divider().padding(.leading, 56).padding(.trailing, 10)
                    }
                    ContactFactRow(icon: fact.icon, label: fact.label, value: fact.value, copy: fact.copy, ltr: fact.ltr)
                }
            }
        }
        .padding(8)
        .panel(12)
    }

    static func deviceLabel(_ device: String?, _ s: Strings) -> String? {
        switch device?.lowercased() {
        case "mobile": return s["deviceMobile"]
        case "tablet": return s["deviceTablet"]
        case "desktop": return s["deviceDesktop"]
        default: return device
        }
    }

    static func longDate(_ when: Date, _ s: Strings) -> String {
        "\(Display.shortDate(when, s.language)) · \(Display.clockTime(when, s.language))"
    }
}

/// A label and its value, with a copy button for what people paste elsewhere.
struct ContactFactRow: View {
    let icon: String
    let label: String
    let value: String
    let copy: Bool
    /// Emails, phone numbers and codes read left to right even in Persian.
    let ltr: Bool
    @Environment(AppModel.self) private var app
    @State private var copied = false

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Palette.brand)
                .frame(width: 32, height: 32)
                .background(Palette.brandSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            Text(label).appFont(13).foregroundStyle(Palette.text2)
                .frame(width: 150, alignment: .leading)
            Text(verbatim: ltr ? "\u{2066}\(value)\u{2069}" : value)
                .appFont(14, .semibold)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if copy {
                Button {
                    ContactActions.copy(value)
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 12))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(copied ? Palette.success : Palette.text2)
                .help(app.strings[copied ? "visitorCopied" : "copy"])
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 10)
    }
}

// MARK: - Conversations

struct ContactChatsPanel: View {
    let model: ContactsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 8) {
            if let error = model.detailError {
                ContactEmptyNote(systemImage: "exclamationmark.triangle", text: error)
            } else if let chats = model.chats {
                if chats.isEmpty {
                    ContactEmptyNote(systemImage: "bubble.left.and.bubble.right", text: app.strings["contactNoConversations"])
                } else {
                    ForEach(chats) { c in
                        Button { model.open(c.id) } label: { ContactChatRow(chat: c) }
                            .buttonStyle(ContactCardButtonStyle())
                    }
                }
            }
        }
    }
}

struct ContactChatRow: View {
    let chat: ContactConversation
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let ai = chat.handledByAi == true && chat.handledByOperator != true
        HStack(alignment: .center, spacing: 14) {
            AvatarView(name: chat.operatorName ?? s["aiReply"], imageURL: chat.operatorAvatar, size: 36, kind: ai ? .ai : .operator)
            VStack(alignment: .leading, spacing: 3) {
                top(s)
                Text(verbatim: preview).appFont(13).foregroundStyle(Palette.text2).lineLimit(1)
            }
            Spacer(minLength: 8)
            meta(s)
        }
    }

    private var preview: String {
        let p = Display.oneLine(chat.lastMessageBody ?? chat.subject)
        return p.isEmpty ? "—" : p
    }

    private func top(_ s: Strings) -> some View {
        let status = chat.status ?? ConversationStatus.open
        let colors = Palette.status(status)
        return HStack(spacing: 8) {
            Chip(text: Display.statusLabel(status, s), foreground: colors.0, background: colors.1)
            if chat.handledByAi == true {
                Chip(text: s["contactHandledByAi"], foreground: Palette.ai, background: Palette.aiSoft, systemImage: "sparkles")
            }
            if let op = chat.operatorName, !op.isEmpty {
                Text(verbatim: op).appFont(12.5, .semibold).lineLimit(1)
            }
        }
    }

    private func meta(_ s: Strings) -> some View {
        VStack(alignment: .trailing, spacing: 3) {
            if let when = chat.updatedAt ?? chat.createdAt {
                Text(Display.listStamp(when, s)).appFont(12).foregroundStyle(Palette.text3)
            }
            if let n = chat.messageCount {
                Text(s.get("contactMessages", "n", s.number(n))).appFont(11.5).foregroundStyle(Palette.text3)
            }
        }
    }
}

// MARK: - Calls

struct ContactCallsPanel: View {
    let model: ContactsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 8) {
            if let calls = model.calls {
                if calls.isEmpty {
                    ContactEmptyNote(systemImage: "phone", text: app.strings["contactNoCalls"])
                } else {
                    ForEach(calls) { call in
                        row(call)
                    }
                }
            }
        }
    }

    @ViewBuilder private func row(_ call: ContactCall) -> some View {
        if let conversation = call.conversationId, !conversation.isEmpty {
            Button { model.open(conversation) } label: { ContactCallRow(call: call) }
                .buttonStyle(ContactCardButtonStyle())
        } else {
            ContactCallRow(call: call)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .panel(12)
        }
    }
}

struct ContactCallRow: View {
    let call: ContactCall
    @Environment(AppModel.self) private var app

    private var video: Bool { call.callType == "video" }

    private var missed: Bool {
        ["missed", "no_answer", "rejected", "failed", "cancelled"].contains(call.state ?? "")
    }

    var body: some View {
        let s = app.strings
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: video ? "video.fill" : "phone.fill")
                .font(.system(size: 14))
                .foregroundStyle(missed ? Palette.danger : Palette.success)
                .frame(width: 36, height: 36)
                .background(missed ? Palette.dangerSoft : Palette.successSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                top(s)
                Text(verbatim: details(s)).appFont(12.5).foregroundStyle(Palette.text2).lineLimit(1)
            }
            Spacer(minLength: 8)
            if let when = call.createdAt {
                Text(Display.listStamp(when, s)).appFont(12).foregroundStyle(Palette.text3)
            }
        }
    }

    private func top(_ s: Strings) -> some View {
        HStack(spacing: 8) {
            Text(s[video ? "videoCall" : "voiceCall"]).appFont(13.5, .semibold)
            if let dir = call.direction, !dir.isEmpty {
                Chip(text: s[dir == "outbound" ? "callOutbound" : "callInbound"], foreground: Palette.text2, background: Palette.elevated)
            }
            if missed {
                Chip(text: s["ccStateMissed"], foreground: Palette.danger, background: Palette.dangerSoft)
            } else {
                Chip(text: s["callStateEnded"], foreground: Palette.success, background: Palette.successSoft)
            }
            if call.recordingAvailable == true && app.plan.callRecordings {
                Chip(text: s["callRecorded"], foreground: Palette.ai, background: Palette.aiSoft, systemImage: "record.circle")
            }
        }
    }

    private func details(_ s: Strings) -> String {
        var parts: [String] = []
        if let agent = call.agentName, !agent.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(agent) }
        if let d = call.durationSeconds, d > 0 { parts.append("\(s["ccHeaderDuration"]) \(Self.duration(d, s))") }
        if let w = call.waitSeconds, w > 0 { parts.append("\(s["ccWaitingLabel"]) \(Self.duration(w, s))") }
        return parts.joined(separator: " · ")
    }

    /// "4:05", or "1:02:09" past an hour, as the Windows contacts page writes it.
    static func duration(_ seconds: Int, _ s: Strings) -> String {
        let t = max(0, seconds)
        let h = t / 3600, m = t % 3600 / 60, sec = t % 60
        let text = h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
        return Digits.localize(text, s.language)
    }
}

// MARK: - Notes and tags

struct ContactNotesCard: View {
    let contact: Contact
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let notes = (contact.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let tags: [String] = contact.tags ?? []
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: notes.isEmpty ? s["contactNoNotes"] : notes)
                .appFont(14)
                .lineSpacing(6)
                .foregroundStyle(notes.isEmpty ? Palette.text3 : Palette.text)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                Text(s["tags"]).appFont(13, .semibold)
                if tags.isEmpty {
                    Text(s["noTags"]).appFont(13).foregroundStyle(Palette.text3)
                } else {
                    FlowLayout(spacing: 6) {
                        ForEach(tags, id: \.self) { tag in
                            Chip(text: tag, foreground: Palette.brand, background: Palette.brandSoft)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .panel(12)
    }
}

// MARK: - Pieces

/// A soft tile with an icon over a line of text, for an empty tab.
struct ContactEmptyNote: View {
    let systemImage: String
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: 20))
                .foregroundStyle(Palette.text3)
                .frame(width: 52, height: 52)
                .background(Palette.elevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            Text(verbatim: text)
                .appFont(13)
                .foregroundStyle(Palette.text2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 36)
        .frame(maxWidth: .infinity)
    }
}

/// A whole card that can be clicked, lifting on hover.
struct ContactCardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ContactCardButton(configuration: configuration)
    }

    private struct ContactCardButton: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(hovering ? Palette.hover : Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
                .opacity(configuration.isPressed ? 0.75 : 1)
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
        }
    }
}
