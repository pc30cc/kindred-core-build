import SwiftUI

/// The call center's content column: the masthead with the calls service's
/// state and my availability, the numbers as on the web desk, and the
/// waiting line or the call log.
struct CallCenterList: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 0) {
            CallDeskMasthead(model: model)
                .padding(.horizontal, 12)
                .padding(.top, 10)
            CallDeskStats(model: model)
                .padding(.horizontal, 12)
                .padding(.top, 10)
            CallDeskListControls(model: model)
                .padding(.top, 10)
            Divider()
            ZStack {
                if model.showHistory {
                    CallDeskHistoryList(model: model)
                } else {
                    CallDeskQueueList(model: model)
                }
                CallDeskListEmpty(model: model)
            }
        }
        .onAppear {
            model.appear()
            takePendingCall()
        }
        .onDisappear { model.disappear() }
        .onChange(of: pendingKey) { _, _ in takePendingCall() }
    }

    /// `app.pendingCall` as something onChange can compare.
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

// MARK: - Masthead

/// Title, service state, my availability, and the two views.
private struct CallDeskMasthead: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "phone.fill")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Palette.brand)
                    .frame(width: 40, height: 40)
                    .background(Palette.brandSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(s["navCallCenter"]).appFont(18, .bold).lineLimit(1)
                        serviceChip
                    }
                    Text(s["ccLiveDesk"]).appFont(12).foregroundStyle(Palette.text2).lineLimit(1)
                }
                Spacer(minLength: 4)
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help(s["refresh"])
                    .keyboardShortcut("r", modifiers: .command)
            }
            HStack(spacing: 8) {
                Text(s["ccStatusLabel"]).appFont(12.5).foregroundStyle(Palette.text2).lineLimit(1)
                Spacer(minLength: 4)
                CallDeskAvailabilityMenu(model: model)
            }
            Picker("", selection: Binding(get: { model.showHistory }, set: { model.setShowHistory($0) })) {
                Text(s["ccLiveDesk"]).tag(false)
                Text(s["ccHistory"]).tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }

    @ViewBuilder private var serviceChip: some View {
        if let ready = model.serviceReady {
            let s = app.strings
            let fg: Color = ready ? Palette.success : Palette.danger
            let bg: Color = ready ? Palette.successSoft : Palette.dangerSoft
            HStack(spacing: 5) {
                Circle().fill(fg).frame(width: 7, height: 7)
                Text(verbatim: "\(s["ccService"]) · \(s[ready ? "ccReady" : "ccDown"])").appFont(11, .semibold).lineLimit(1)
            }
            .foregroundStyle(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 2.5)
            .background(bg, in: Capsule())
        }
    }
}

/// Available / away for calls, as the web desk's agent status.
private struct CallDeskAvailabilityMenu: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        Menu {
            Button { model.setAvailability("available") } label: {
                if model.availability == "available" {
                    Label(s["ccAvailable"], systemImage: "checkmark")
                } else {
                    Text(s["ccAvailable"])
                }
            }
            Button { model.setAvailability("away") } label: {
                if model.availability == "away" {
                    Label(s["ccAway"], systemImage: "checkmark")
                } else {
                    Text(s["ccAway"])
                }
            }
        } label: {
            HStack(spacing: 6) {
                Circle().fill(dotColor).frame(width: 8, height: 8)
                Text(title).appFont(12.5, .semibold).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.text3)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .glassCapsule(interactive: true)
        .help(s["ccStatusLabel"])
    }

    private var title: String {
        let s = app.strings
        switch model.availability {
        case "available": return s["ccAvailable"]
        case "away": return s["ccAway"]
        default: return s["ccSetAvailable"]
        }
    }

    private var dotColor: Color {
        switch model.availability {
        case "available": return Palette.success
        case "away": return Palette.warning
        default: return Palette.text3
        }
    }
}

// MARK: - The numbers

/// Waiting, active, longest wait, SLA breached, missed today, today — as on the web desk.
private struct CallDeskStats: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let o = model.overview
        let columns: [GridItem] = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)
        LazyVGrid(columns: columns, spacing: 8) {
            CallDeskStat(label: s["ccWaiting"], value: s.number(model.waitingCount), color: Palette.warning)
            CallDeskStat(label: s["ccActive"], value: count(o?.activeCalls), color: Palette.success)
            CallDeskStat(label: s["ccLongestWait"], value: CallDeskText.wait(model.longestWait, s.language), color: Palette.text)
            CallDeskStat(label: s["ccSlaBreached"], value: s.number(model.slaBreached), color: Palette.danger)
            CallDeskStat(label: s["ccMissedToday"], value: count(o?.missedToday), color: Palette.text)
            CallDeskStat(label: s["ccToday"], value: count(o?.todayCalls), color: Palette.text)
        }
    }

    private func count(_ n: Int?) -> String {
        guard model.overview != nil else { return "—" }
        return app.strings.number(n ?? 0)
    }
}

private struct CallDeskStat: View {
    let label: String
    let value: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).appFont(10.5, .semibold).foregroundStyle(Palette.text3).lineLimit(1).minimumScaleFactor(0.8)
            Text(value).appFont(18, .bold).foregroundStyle(color).lineLimit(1).monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .panel(10)
    }
}

// MARK: - List chrome

/// The list's title, sort, search box and channel filter.
private struct CallDeskListControls: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Text(model.showHistory ? s["ccHistory"] : s["ccQueue"]).appFont(15, .semibold).lineLimit(1)
                if !model.showHistory {
                    CountBadge(count: model.waitingCount, color: Palette.danger)
                }
                Spacer(minLength: 4)
                if !model.showHistory {
                    Button { model.toggleSort() } label: {
                        Image(systemName: model.newestFirst ? "arrow.down.circle" : "hourglass")
                    }
                    .buttonStyle(.borderless)
                    .help(s[model.newestFirst ? "ccSortNewest" : "ccSortLongest"])
                }
            }
            .padding(.horizontal, 4)
            SearchField(prompt: s["ccSearch"], text: $model.search)
            Picker("", selection: $model.channel) {
                Text(s["ccFilterAll"]).tag("all")
                Label(s["ccFilterVoice"], systemImage: "phone").tag("voice")
                Label(s["ccFilterVideo"], systemImage: "video").tag("video")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
    }
}

/// Nothing in the list on show: why, and the loading state.
private struct CallDeskListEmpty: View {
    let model: CallCenterModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        if model.showHistory {
            if model.visibleHistory.isEmpty {
                if model.historyLoading || !model.historyLoaded {
                    ProgressView().controlSize(.regular)
                } else {
                    EmptyState(systemImage: "phone", title: s["ccNoHistory"])
                }
            }
        } else if model.visibleQueue.isEmpty {
            if model.waitingCount == 0 {
                EmptyState(systemImage: "phone", title: s["ccNoCalls"], message: s["ccNoCallsHint"])
            } else {
                EmptyState(systemImage: "line.3.horizontal.decrease.circle", title: s["ccNoMatches"])
            }
        }
    }
}

// MARK: - The waiting line

private struct CallDeskQueueList: View {
    let model: CallCenterModel

    var body: some View {
        let items = model.visibleQueue
        ScrollViewReader { proxy in
            List(selection: Binding(get: { model.selectedId }, set: { model.select($0) })) {
                ForEach(items) { item in
                    CallDeskQueueRow(model: model, item: item)
                        .tag(item.id)
                        .id(item.id)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 1, leading: 6, bottom: 1, trailing: 6))
                        .contextMenu { CallDeskQueueMenu(model: model, id: item.id) }
                }
            }
            .listStyle(.inset)
            .scrollContentBackground(.hidden)
            .animation(.smooth(duration: 0.2), value: items.map(\.id))
            .onChange(of: model.scrollRequest) { _, id in
                if let id { withAnimation { proxy.scrollTo(id) } }
            }
        }
    }
}

/// Right-click on a waiting call: answer or decline without opening it first.
private struct CallDeskQueueMenu: View {
    let model: CallCenterModel
    let id: String
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        Button {
            model.select(id)
            Task { await model.accept() }
        } label: { Label(s["ccAcceptNow"], systemImage: "phone.fill") }
        Button(role: .destructive) {
            model.select(id)
            Task { await model.reject() }
        } label: { Label(s["ccReject"], systemImage: "phone.down.fill") }
    }
}

/// A call waiting in the queue, with a wait clock that ticks every second.
private struct CallDeskQueueRow: View {
    let model: CallCenterModel
    let item: CallDeskItem
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let c = item.entry.callSession
        HStack(alignment: .center, spacing: 12) {
            CallerAvatar(call: c, sessionId: item.entry.visitorSessionId, size: 42)
                .overlay(alignment: .bottomTrailing) { channelBadge }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(Digits.localize("#\(item.rank)", s.language))
                        .appFont(11.5, .bold)
                        .foregroundStyle(Palette.text3)
                    Text(item.name).appFont(13.5, .semibold).lineLimit(1)
                    if let p = item.entry.priority, p > 0 {
                        Chip(text: Digits.localize("P\(p)", s.language), foreground: Palette.danger, background: Palette.dangerSoft)
                    }
                }
                let detail = item.detail
                if !detail.isEmpty {
                    Text(detail).appFont(12).foregroundStyle(Palette.text2).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            CallDeskWaitPill(model: model, entry: item.entry)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .help(s[item.entry.isVideo ? "ccVideo" : "ccVoice"])
    }

    private var channelBadge: some View {
        Image(systemName: CallDeskText.channelIcon(video: item.entry.isVideo))
            .font(.system(size: 8.5, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 18, height: 18)
            .background(Palette.brand, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Palette.surface, lineWidth: 2))
            .offset(x: 4, y: 4)
    }
}

/// m:ss since the call came in, amber after a minute and red after three.
private struct CallDeskWaitPill: View {
    let model: CallCenterModel
    let entry: QueueEntry
    @Environment(AppModel.self) private var app

    var body: some View {
        let now = model.now
        let wait = max(0, now.timeIntervalSince(CallDeskItem.since(entry, now)))
        let colors = CallDeskText.waitColors(wait)
        HStack(spacing: 4) {
            Image(systemName: "clock").font(.system(size: 10, weight: .semibold))
            Text(CallDeskText.wait(wait, app.strings.language)).appFont(12.5, .semibold).monospacedDigit()
        }
        .foregroundStyle(colors.0)
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .background(colors.1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .environment(\.layoutDirection, .leftToRight)
    }
}

// MARK: - The call log

private struct CallDeskHistoryList: View {
    let model: CallCenterModel

    var body: some View {
        let calls = model.visibleHistory
        List(selection: Binding(get: { model.selectedId }, set: { model.select($0) })) {
            ForEach(calls) { c in
                CallDeskHistoryRow(call: c)
                    .tag(c.id)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 1, leading: 6, bottom: 1, trailing: 6))
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
    }
}

/// A finished or ongoing call in the log.
private struct CallDeskHistoryRow: View {
    let call: CallSession
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let c = call
        let colors = CallDeskText.stateColors(c.state)
        HStack(alignment: .center, spacing: 12) {
            CallerAvatar(call: c, size: 36)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: CallDeskText.channelIcon(video: c.isVideo))
                        .font(.system(size: 7.5, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 16, height: 16)
                        .background(colors.0, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Palette.surface, lineWidth: 2))
                        .offset(x: 4, y: 4)
                }
            VStack(alignment: .leading, spacing: 1) {
                Text(CallNames.caller(c, fallbackId: c.contactId ?? c.visitorSessionId ?? c.id, s))
                    .appFont(13, .semibold)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(CallDeskText.state(c.state, s)).appFont(12).foregroundStyle(colors.0).lineLimit(1)
                    if c.isSpam {
                        Label(s["callSpam"], systemImage: "xmark.bin").appFont(11, .semibold).foregroundStyle(Palette.danger).lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                if let at = c.createdAt {
                    Text(Display.listStamp(at, s)).appFont(12).foregroundStyle(Palette.text2)
                }
                Text(CallDeskText.duration(c.durationSeconds, s.language)).appFont(12).foregroundStyle(Palette.text3).monospacedDigit()
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
    }
}
