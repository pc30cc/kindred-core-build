import SwiftUI

/// The call center's detail column: the call picked — the caller and the big
/// buttons, their contact and page, the call's timeline, earlier calls, and
/// notes — or a quiet placeholder.
struct CallCenterDetail: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app

    var body: some View {
        // The strip sits over the call in the column's own stack. As a top safe-area inset
        // that comes and goes, it made the whole window give up its title-bar inset — the
        // page jumped up under the title bar and stayed there until the strip was closed.
        VStack(spacing: 0) {
            noticeBar
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.chatBackground)
        .animation(.smooth(duration: 0.2), value: model.notice)
        .onAppear {
            model.appear()
            takePendingCall()
        }
        .onDisappear { model.disappear() }
        .onChange(of: pendingKey) { _, _ in takePendingCall() }
    }

    @ViewBuilder private var content: some View {
        if let call = model.shownCall, let id = model.selectedId {
            CallDeskCallView(model: model, call: call)
                .id(id)
        } else {
            EmptyState(systemImage: "person.crop.circle", title: app.strings["ccNoCallSelected"], message: app.strings["ccNoCallSelectedHint"])
        }
    }

    @ViewBuilder private var noticeBar: some View {
        #if DEBUG
        if CallCenterModel.debugVariant == 1, let notice = model.notice {
            Text(notice.message).padding(10).frame(maxWidth: .infinity).background(Color.blue.opacity(0.15))
        } else if CallCenterModel.debugVariant == 2, let notice = model.notice {
            Banner(severity: notice.severity, title: notice.title, message: notice.message)
                .padding(.horizontal, 14).padding(.top, 8)
        } else if CallCenterModel.debugVariant == 3, model.notice != nil {
            Color.red.frame(height: 40)
        } else if let notice = model.notice {
        #else
        if let notice = model.notice {
        #endif
            Banner(severity: notice.severity, title: notice.title, message: notice.message,
                   actionTitle: notice.addNote ? app.strings["ccAddNote"] : nil,
                   action: notice.addNote ? { model.focusNote() } : nil,
                   onClose: { model.notice = nil })
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// `app.pendingCall`, in case this column is on screen without the list.
    private var pendingKey: String? {
        guard let p = app.pendingCall else { return nil }
        return "\(p.id)|\(p.answer)"
    }

    private func takePendingCall() {
        guard let p = app.pendingCall else { return }
        app.pendingCall = nil
        model.handlePending(id: p.id, answer: p.answer)
    }
}

// MARK: - The call

private struct CallDeskCallView: View {
    let model: CallCenterModel
    let call: CallSession
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                CallDeskCallerCard(model: model, call: call)
                HStack(alignment: .top, spacing: 14) {
                    CallDeskSection(title: app.strings["ccContact"]) { contactRows }
                    CallDeskSection(title: app.strings["ccPageContext"]) { pageRows }
                }
                HStack(alignment: .top, spacing: 14) {
                    CallDeskSection(title: app.strings["ccTimeline"]) { CallDeskTimeline(events: model.events) }
                    CallDeskSection(title: app.strings["ccPreviousCalls"]) { CallDeskPrevious(calls: model.previous, loading: model.previousLoading) }
                }
                CallDeskSection(title: app.strings["ccNotes"]) { CallDeskNotes(model: model) }
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 24)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var contactRows: some View {
        let s = app.strings
        CallDeskInfoLine(icon: "person", label: s["ccName"], value: call.visitorName ?? model.shownName)
        if let email = call.visitorEmail, !email.isEmpty {
            CallDeskInfoLine(icon: "envelope", label: s["ccEmail"], value: email, ltr: true)
        }
        if let phone = call.visitorPhone, !phone.isEmpty {
            CallDeskInfoLine(icon: "phone", label: s["ccPhone"], value: phone, ltr: true)
        }
    }

    @ViewBuilder private var pageRows: some View {
        let s = app.strings
        let subject = call.subject ?? ""
        let title = call.pageTitle ?? ""
        let url = call.pageUrl ?? ""
        if !subject.isEmpty { CallDeskInfoLine(icon: "text.bubble", label: s["ccSubject"], value: subject) }
        if !title.isEmpty { CallDeskInfoLine(icon: "doc.text", label: s["visitorCurrentPage"], value: title) }
        if !url.isEmpty { CallDeskInfoLine(icon: "link", label: "URL", value: url, ltr: true) }
        if subject.isEmpty && title.isEmpty && url.isEmpty { CallDeskMuted(text: "—") }
    }
}

/// The caller, the call's state and channel, and answer / decline / end.
private struct CallDeskCallerCard: View {
    let model: CallCenterModel
    let call: CallSession
    @Environment(AppModel.self) private var app

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 18) {
                identity
                Spacer(minLength: 8)
                buttons
            }
            VStack(alignment: .leading, spacing: 14) {
                identity
                buttons
            }
        }
        .padding(20)
        .panel(16)
    }

    private var identity: some View {
        let s = app.strings
        let waiting = model.selectedIsWaiting
        let state: String? = waiting ? "queued" : call.state
        let colors = CallDeskText.stateColors(state)
        let video = model.shownIsVideo
        return HStack(spacing: 18) {
            AvatarView(name: call.visitorName, email: call.visitorEmail, size: 64)
            VStack(alignment: .leading, spacing: 4) {
                Text(model.shownName).appFont(19, .bold).lineLimit(1).textSelection(.enabled)
                HStack(spacing: 8) {
                    Chip(text: CallDeskText.state(state, s), foreground: colors.0, background: colors.1)
                    Chip(text: s[video ? "ccVideo" : "ccVoice"], systemImage: video ? "video.fill" : "phone.fill")
                }
                CallDeskWaitLine(model: model, call: call)
            }
        }
    }

    @ViewBuilder private var buttons: some View {
        let s = app.strings
        let waiting = model.selectedIsWaiting
        let onCall = model.isOnCall(call)
        let busy = model.accepting || model.rejecting
        if waiting || onCall {
            GlassGroup(spacing: 10) {
                HStack(spacing: 10) {
                    if waiting {
                        Button { Task { await model.reject() } } label: {
                            Label(s["ccReject"], systemImage: "phone.down.fill").appFont(13, .semibold)
                        }
                        .glassButton()
                        .tint(Palette.danger)
                        .foregroundStyle(Palette.danger)
                        .controlSize(.large)
                        .disabled(busy)
                        Button { Task { await model.accept() } } label: { acceptLabel }
                            .prominentButton(tint: Palette.success)
                            .controlSize(.large)
                            .disabled(busy)
                    }
                    if onCall {
                        Button { Task { await model.end() } } label: {
                            Label(s["ccEnd"], systemImage: "phone.down.fill").appFont(13, .semibold)
                        }
                        .prominentButton(tint: Palette.danger)
                        .controlSize(.large)
                        .disabled(model.ending)
                    }
                }
            }
        }
    }

    @ViewBuilder private var acceptLabel: some View {
        let s = app.strings
        if model.accepting {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(s["ccAnswering"]).appFont(13, .semibold)
            }
        } else {
            Label(s["ccAcceptNow"], systemImage: model.shownIsVideo ? "video.fill" : "phone.fill").appFont(13, .semibold)
        }
    }
}

/// Waiting m:ss while in the line; on call with…; else when it started.
private struct CallDeskWaitLine: View {
    let model: CallCenterModel
    let call: CallSession
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let text: String = {
            if model.selectedIsWaiting {
                return s.get("ccQueuedFor", "time", CallDeskText.wait(model.selectedWait, s.language))
            }
            if model.isOnCall(call) { return s.get("ccOnCallWith", "name", model.shownName) }
            if let at = call.createdAt { return "\(s["ccStartedAt"]) \(Display.listStamp(at, s))" }
            return ""
        }()
        if !text.isEmpty {
            Text(text).appFont(12.5).foregroundStyle(Palette.text2).lineLimit(1)
        }
    }
}

// MARK: - Sections

/// A small-caps title over a white card.
private struct CallDeskSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(text: title)
            VStack(alignment: .leading, spacing: 10) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .panel(12)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// An icon, a small label and a selectable value; addresses and numbers stay left-to-right.
private struct CallDeskInfoLine: View {
    let icon: String
    let label: String
    let value: String
    var ltr = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(Palette.brand)
                .frame(width: 16)
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 1) {
                Text(label).appFont(11).foregroundStyle(Palette.text3)
                Text(verbatim: ltr ? "\u{2066}\(value)\u{2069}" : value)
                    .appFont(13)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct CallDeskMuted: View {
    let text: String

    var body: some View {
        Text(text).appFont(12.5).foregroundStyle(Palette.text2).fixedSize(horizontal: false, vertical: true)
    }
}

/// What happened on the call, oldest first, on a rail of coloured dots.
private struct CallDeskTimeline: View {
    let events: [CallEvent]?
    @Environment(AppModel.self) private var app

    var body: some View {
        if let events {
            if events.isEmpty {
                CallDeskMuted(text: app.strings["ccNoEvents"])
            } else {
                let ordered = events.sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(ordered.indices, id: \.self) { i in
                        CallDeskTimelineRow(event: ordered[i], last: i == ordered.count - 1)
                    }
                }
            }
        } else {
            ProgressView().controlSize(.small)
        }
    }
}

private struct CallDeskTimelineRow: View {
    let event: CallEvent
    let last: Bool
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        HStack(alignment: .top, spacing: 10) {
            ZStack(alignment: .top) {
                if !last {
                    Rectangle()
                        .fill(Palette.line)
                        .frame(width: 2)
                        .frame(maxHeight: .infinity)
                        .padding(.top, 12)
                }
                Circle()
                    .fill(CallDeskText.eventColor(event.eventType))
                    .frame(width: 9, height: 9)
                    .padding(.top, 4)
            }
            .frame(width: 12)
            .frame(maxHeight: .infinity, alignment: .top)
            VStack(alignment: .leading, spacing: 1) {
                Text(CallDeskText.event(event.eventType, s)).appFont(12.5, .semibold)
                if let at = event.createdAt {
                    Text(Display.clockTime(at, s.language)).appFont(11).foregroundStyle(Palette.text3)
                }
            }
            .padding(.bottom, 10)
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// Up to eight earlier calls from the same visitor.
private struct CallDeskPrevious: View {
    let calls: [CallSession]?
    let loading: Bool
    @Environment(AppModel.self) private var app

    var body: some View {
        if loading {
            ProgressView().controlSize(.small)
        } else if let calls {
            if calls.isEmpty {
                CallDeskMuted(text: app.strings["ccFirstCall"])
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(calls) { c in row(c) }
                }
            }
        } else {
            CallDeskMuted(text: "—")
        }
    }

    private func row(_ c: CallSession) -> some View {
        let s = app.strings
        let color = CallDeskText.stateColors(c.state).0
        let when = c.createdAt.map { Display.listStamp($0, s) } ?? ""
        return HStack(spacing: 10) {
            Image(systemName: CallDeskText.channelIcon(video: c.isVideo)).font(.system(size: 12)).foregroundStyle(color)
            Text(CallDeskText.state(c.state, s)).appFont(12.5).foregroundStyle(color).lineLimit(1)
            Spacer(minLength: 6)
            Text(verbatim: "\(when) · \(CallDeskText.duration(c.durationSeconds, s.language))").appFont(12).foregroundStyle(Palette.text3).lineLimit(1)
        }
    }
}

/// The notes on the call and the box to add one.
private struct CallDeskNotes: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app
    @FocusState private var noteFocused: Bool

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        let notes = (model.notes ?? []).sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        VStack(alignment: .leading, spacing: 10) {
            if !notes.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(notes) { n in noteBubble(n) }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(s["ccNotePlaceholder"], text: $model.noteDraft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .appFont(13)
                    .lineLimit(3...8)
                    .focused($noteFocused)
                    .padding(10)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.line, lineWidth: 1))
                Button { Task { await model.addNote() } } label: {
                    if model.addingNote {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(s["ccAddNote"]).appFont(13, .semibold)
                    }
                }
                .prominentButton()
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(model.addingNote || model.noteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onChange(of: model.noteDraft) { _, text in
            if text.count > 2000 { model.noteDraft = String(text.prefix(2000)) }
        }
        .onChange(of: model.focusNoteRequest) { _, _ in noteFocused = true }
    }

    private func noteBubble(_ n: CallNote) -> some View {
        let s = app.strings
        let when = n.createdAt.map { Display.listStamp($0, s) } ?? ""
        return VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: "\(n.authorName ?? "") · \(when)").appFont(11.5).foregroundStyle(Palette.text2)
            Text(n.note).appFont(13).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Palette.noteBubble, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.noteBorder, lineWidth: 1))
    }
}
