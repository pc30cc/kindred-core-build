import AppKit
import SwiftUI

/// The team, as the Windows app's colleagues pane draws it: avatar with the
/// colleague's presence, name, last message, time and the unread count;
/// unread first, then who is active.
struct ColleaguesList: View {
    let model: ColleaguesModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        VStack(spacing: 0) {
            header
            SearchField(prompt: s["colleaguesSearch"], text: $model.search)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            content
            // Super Admin's ad for this place (Desktop app -> Ads & announcements).
            CampaignCard(placement: "colleagues_list").padding(8)
        }
        .onAppear { model.start() }
        .onDisappear { model.suspend() }
    }

    private var content: some View {
        let s = app.strings
        let list = model.visible
        return ZStack {
            List(selection: Binding(get: { model.peerId }, set: { model.select($0) })) {
                ForEach(list) { c in
                    ColleagueRow(colleague: c, presence: model.presence(of: c.userId))
                        .tag(c.userId)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 1, leading: 6, bottom: 1, trailing: 6))
                }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
            .animation(.smooth(duration: 0.2), value: list.map(\.userId))

            if model.loading && list.isEmpty {
                ProgressView().controlSize(.regular)
            } else if list.isEmpty {
                EmptyState(systemImage: "person.2", title: s["colleaguesEmptyTitle"], message: s["colleaguesEmptyBody"])
            }
        }
    }

    private var header: some View {
        let s = app.strings
        return HStack(spacing: 10) {
            Image(systemName: "person.2.fill")
                .font(.system(size: 14))
                .foregroundStyle(Palette.brand)
                .frame(width: 34, height: 34)
                .background(Palette.brandSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(s["colleagues"]).appFont(20, .bold).lineLimit(1)
                if model.loaded {
                    Text(s.get("colleaguesOnline", "n", s.number(model.onlineCount)))
                        .appFont(11.5)
                        .foregroundStyle(Palette.text3)
                        .lineLimit(1)
                }
            }
            Spacer()
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help(s["refresh"])
                .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

struct ColleagueRow: View {
    let colleague: Colleague
    let presence: String
    @Environment(AppModel.self) private var app

    var body: some View {
        let c = colleague
        let s = app.strings
        let unread = max(0, c.unread ?? 0)
        HStack(alignment: .center, spacing: 12) {
            AvatarView(name: c.displayName, imageURL: c.avatarUrl, size: 42, kind: .operator, presence: presence)
            VStack(alignment: .leading, spacing: 2) {
                Text(c.displayName)
                    .appFont(13.5, unread > 0 ? .bold : .semibold)
                    .lineLimit(1)
                Text(ColleaguesModel.preview(c, s))
                    .appFont(12.5)
                    .foregroundStyle(unread > 0 ? Palette.text : Palette.text2)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 6) {
                if let when = c.lastMessage?.createdAt {
                    TimelineView(.periodic(from: .now, by: 60)) { ctx in
                        Text(Display.listStamp(when, now: ctx.date, s)).appFont(11).foregroundStyle(Palette.text3)
                    }
                }
                if unread > 0 {
                    Text(s.number(unread))
                        .appFont(10.5, .bold)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Palette.brand, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .contextMenu {
            if let mail = c.email, !mail.isEmpty, let url = URL(string: "mailto:" + mail) {
                Button { NSWorkspace.shared.open(url) } label: { Label(s["contactSendEmail"], systemImage: "envelope") }
            }
        }
    }
}
