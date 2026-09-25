import SwiftUI

/// Beside a conversation: who the visitor is and where from, the
/// conversation's state, its tags, and the team's private notes.
struct DetailsPanel: View {
    let chat: ChatModel
    @Environment(AppModel.self) private var app
    @State private var tagInput = ""
    @State private var noteInput = ""
    @State private var addingNote = false
    @State private var members: [WorkspaceMember] = []

    var body: some View {
        let s = app.strings
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let c = chat.conversation {
                    contact(c, s)
                    Divider()
                    conversation(c, s)
                    Divider()
                    tags(c, s)
                    Divider()
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
                notes(s)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { members = (try? await app.loadMembers()) ?? [] }
    }

    private func contact(_ c: Conversation, _ s: Strings) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(spacing: 8) {
                AvatarView(name: c.contacts?.name, email: c.contacts?.email, os: c.visitorOs, countryCode: c.visitorCountryCode,
                           imageURL: c.contacts?.avatarUrl, size: 64)
                Text(Display.conversationName(c, s)).appFont(15, .bold).multilineTextAlignment(.center)
                if let email = c.contacts?.email, !email.isEmpty {
                    Text(email).appFont(12).foregroundStyle(Palette.text2).textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity)
            SectionLabel(text: s["contactInfo"])
            if let p = chat.profile {
                let place = [p.geo?.city, p.geo?.country].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: s.isRightToLeft ? "، " : ", ")
                if !place.isEmpty { FactRow(systemImage: "mappin.and.ellipse", text: [AvatarArt.flag(p.geo?.countryCode), place].compactMap { $0 }.joined(separator: " ")) }
                let device = [p.device?.os, p.device?.browser, p.device?.device].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                if !device.isEmpty { FactRow(systemImage: "desktopcomputer", text: device) }
            }
            if let code = c.contacts?.visitorCode, !code.isEmpty {
                FactRow(systemImage: "number", text: code, selectable: true)
            }
        }
    }

    private func conversation(_ c: Conversation, _ s: Strings) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: s["conversationInfo"])
            // Status, priority and who owns it are changed right here, as in the web inbox's side panel.
            ChoiceField(label: s["status"], value: Display.statusLabel(c.status, s), valueColor: Palette.status(c.status).0,
                        leading: Choice(id: "", title: "", dot: Palette.status(c.status).0),
                        choices: [ConversationStatus.open, ConversationStatus.pending, ConversationStatus.resolved].map {
                            Choice(id: $0, title: Display.statusLabel($0, s), dot: Palette.status($0).0)
                        },
                        selected: c.status, disabled: chat.busy) { chat.setStatus($0) }
            ChoiceField(label: s["priority"], value: Display.priorityLabel(c.priority, s), valueColor: Palette.priority(c.priority).0,
                        leading: Choice(id: "", title: "", dot: Palette.priority(c.priority).0),
                        choices: ConversationPriority.all.map { Choice(id: $0, title: Display.priorityLabel($0, s), dot: Palette.priority($0).0) },
                        selected: c.priority ?? ConversationPriority.normal, disabled: chat.busy) { chat.setPriority($0) }
            ChoiceField(label: s["assignee"], value: app.assigneeName(c.assignedTo, youKey: "you"),
                        leading: assigneeChoice(c.assignedTo),
                        choices: assigneeChoices(s), selected: c.assignedTo ?? Self.nobody,
                        searchable: members.count > 8, disabled: chat.busy) { id in
                if id == Self.nobody { chat.unassign() } else { chat.transfer(to: id) }
            }
            InfoRow(label: s["firstSeen"], value: c.createdAt.map { Display.dateTime($0, s) } ?? "—")
        }
    }

    private static let nobody = "__nobody__"

    /// Nobody, then you, then the rest of the team with their photos.
    private func assigneeChoices(_ s: Strings) -> [Choice] {
        let me = app.user?.id
        let active = members.filter { $0.suspendedAt == nil }
        var list = [Choice(id: Self.nobody, title: s["unassigned"], systemImage: "person.crop.circle.badge.xmark", tint: Palette.text3)]
        if let me, let mine = active.first(where: { $0.userId == me }) {
            list.append(Choice(id: me, title: "\(mine.displayName) (\(s["you"]))", person: (mine.displayName, app.account?.avatarUrl ?? mine.profile?.avatarUrl)))
        }
        for m in active where m.userId != me {
            list.append(Choice(id: m.userId, title: m.displayName, person: (m.displayName, m.profile?.avatarUrl)))
        }
        return list
    }

    private func assigneeChoice(_ userId: String?) -> Choice? {
        guard let userId else { return nil }
        let m = members.first { $0.userId == userId }
        let photo = userId == app.user?.id ? (app.account?.avatarUrl ?? m?.profile?.avatarUrl) : m?.profile?.avatarUrl
        return Choice(id: userId, title: "", person: (m?.displayName ?? "", photo))
    }

    private func tags(_ c: Conversation, _ s: Strings) -> some View {
        let tags = c.tags ?? []
        return VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: s["tags"])
            if tags.isEmpty {
                Text(s["noTags"]).appFont(12).foregroundStyle(Palette.text2)
            } else {
                FlowLayout(spacing: 6) {
                    ForEach(tags, id: \.self) { tag in
                        HStack(spacing: 4) {
                            Text(tag).appFont(11.5, .semibold)
                            Button { chat.setTags(tags.filter { $0 != tag }) } label: {
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                            }
                            .buttonStyle(.borderless)
                            .help(s["removeTag"])
                        }
                        .foregroundStyle(Palette.brand)
                        .padding(.leading, 10)
                        .padding(.trailing, 6)
                        .padding(.vertical, 3)
                        .background(Palette.brandSoft, in: Capsule())
                    }
                }
            }
            TextField(s["tagPlaceholder"], text: $tagInput)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    chat.addTag(tagInput)
                    tagInput = ""
                }
        }
    }

    private func notes(_ s: Strings) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: s["internalNotes"])
            Text(s["notesPrivacyNote"]).appFont(11).foregroundStyle(Palette.text2)
            if chat.notes.isEmpty {
                Text(s["noNotes"]).appFont(12).foregroundStyle(Palette.text2)
            }
            ForEach(chat.notes) { n in
                let author = (n.author?.fullName).flatMap { $0.isEmpty ? nil : $0 } ?? n.author?.email ?? s["you"]
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        AvatarView(name: author, imageURL: n.author?.avatarUrl, size: 22, kind: .operator)
                        Text("\(author) · \(n.createdAt.map { Display.listStamp($0, s) } ?? "")")
                            .appFont(11).foregroundStyle(Palette.text2).lineLimit(1)
                        Spacer(minLength: 0)
                        if n.authorId == nil || n.authorId == app.user?.id {
                            Button { chat.deleteNote(n.id) } label: { Image(systemName: "trash").font(.system(size: 10)) }
                                .buttonStyle(.borderless)
                                .foregroundStyle(Palette.text3)
                                .help(s["deleteNote"])
                        }
                    }
                    Text(n.body).appFont(12.5).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                .padding(EdgeInsets(top: 8, leading: 12, bottom: 10, trailing: 8))
                .background(Palette.noteBubble, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.noteBorder, lineWidth: 1))
            }
            TextField(s["writeNote"], text: $noteInput, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(3...8)
                .padding(8)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.lineStrong, lineWidth: 1))
            Button {
                addingNote = true
                Task {
                    if await chat.addNote(noteInput) { noteInput = "" }
                    addingNote = false
                }
            } label: {
                Text(s["addNote"]).frame(maxWidth: .infinity)
            }
            .glassButton()
            .disabled(addingNote || noteInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
}
