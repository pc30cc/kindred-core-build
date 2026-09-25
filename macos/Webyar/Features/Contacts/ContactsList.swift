import AppKit
import SwiftUI

/// The contacts column: the title with the count, the search, everyone who
/// has talked to the workspace (avatar with OS and flag, name, how to reach
/// them, where from), and the Super Admin's ad for this place.
struct ContactsList: View {
    let model: ContactsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        VStack(spacing: 0) {
            header
            SearchField(prompt: s["contactsSearch"], text: $model.search)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            Divider()
            content
            if let error = model.error, !model.all.isEmpty {
                Banner(severity: .warning, message: error, actionTitle: s["retry"], action: { model.reload() })
                    .padding(8)
            }
            // Super Admin's ad for this place (Desktop app -> Ads & announcements).
            CampaignCard(placement: "contacts_list").padding(8)
        }
        .onAppear { model.start() }
        .onChange(of: app.workspace?.id) { _, _ in model.start() }
        .onChange(of: app.strings.language) { _, _ in model.relabel() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(app.strings["tabContacts"]).appFont(20, .bold).lineLimit(1)
            if !model.loading || !model.all.isEmpty {
                Chip(text: app.strings.number(model.all.count), foreground: Palette.brand, background: Palette.brandSoft)
            }
            Spacer()
            Button { model.reload() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help(app.strings["refresh"])
                .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder private var content: some View {
        let list: [ContactItem] = model.visible
        ZStack {
            ScrollViewReader { proxy in
                List {
                    ForEach(list) { item in
                        ContactRow(item: item, selected: item.id == model.selectedId)
                            .onTapGesture { model.select(item.id) }
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6))
                            .contextMenu { rowMenu(item) }
                    }
                }
                .listStyle(.inset)
                .scrollContentBackground(.hidden)
                .arrowKeyPicking(list.map(\.id), selected: model.selectedId, proxy: proxy, select: { model.select($0) })
            }

            if model.loading && model.all.isEmpty {
                ProgressView().controlSize(.regular)
            } else if list.isEmpty {
                emptyView
            }
        }
        .frame(maxHeight: .infinity)
    }

    @ViewBuilder private var emptyView: some View {
        let s = app.strings
        if let error = model.error, model.all.isEmpty {
            VStack(spacing: 12) {
                EmptyState(systemImage: "exclamationmark.triangle", title: error, tint: Palette.warning)
                Button(s["retry"]) { model.reload() }.glassButton()
            }
        } else {
            EmptyState(systemImage: "person.2", title: s["contactsEmptyTitle"], message: s["contactsEmptyBody"])
        }
    }

    @ViewBuilder private func rowMenu(_ item: ContactItem) -> some View {
        let s = app.strings
        if let email = item.email, !email.isEmpty {
            Button(s["contactSendEmail"]) { ContactActions.sendEmail(email) }
            Button("\(s["copy"]) — \(s["emailLabel"])") { ContactActions.copy(email) }
        }
        if let phone = item.contact.phone, !phone.isEmpty {
            Button("\(s["copy"]) — \(s["phoneLabel"])") { ContactActions.copy(phone) }
        }
    }
}

/// One contact in the list.
struct ContactRow: View {
    let item: ContactItem
    var selected = false

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            AvatarView(name: item.name, email: item.email, os: item.os, countryCode: item.countryCode,
                       imageURL: item.avatarUrl, size: 40, faceless: true)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: item.name).appFont(13.5, .semibold).lineLimit(1)
                if !item.subtitle.isEmpty {
                    Text(verbatim: item.subtitle).appFont(12).foregroundStyle(Palette.text2).lineLimit(1)
                }
                if !item.location.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "mappin.and.ellipse").font(.system(size: 9)).foregroundStyle(Palette.text3)
                        Text(verbatim: item.location).appFont(11).foregroundStyle(Palette.text3).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 2)
        .selectableRow(selected)
    }
}

/// Mail and clipboard, shared by the list and the profile.
@MainActor
enum ContactActions {
    static func sendEmail(_ email: String) {
        let allowed = CharacterSet.urlPathAllowed
        let encoded = email.addingPercentEncoding(withAllowedCharacters: allowed) ?? email
        if let url = URL(string: "mailto:" + encoded) { NSWorkspace.shared.open(url) }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
