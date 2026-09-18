import SwiftUI
import Observation

/// Everything the Call Center screen needs, fetched together.
struct CallCenterData: Sendable {
    let overview: CallOverview
    let queue: [QueueEntry]
    let history: [CallRecord]
}

@MainActor
@Observable
final class CallCenterViewModel {
    private(set) var state: LoadState<CallCenterData> = .loading

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    func load(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else {
            state = .failed(.transport)
            return
        }
        do {
            // Three independent reads; running them together keeps the screen
            // from appearing in stages.
            async let overview = api.callOverview(workspaceID: workspaceID)
            async let queue = api.callQueue(workspaceID: workspaceID)
            async let history = api.callHistory(workspaceID: workspaceID)
            state = .loaded(CallCenterData(
                overview: try await overview,
                queue: try await queue,
                history: try await history
            ))
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch let error as APIError {
            state = .failed(error)
        } catch {
            state = .failed(.transport)
        }
    }

    /// Pull-to-refresh keeps what is on screen if the refresh fails.
    func refresh(workspaceID: String?, appState: AppState) async {
        guard let workspaceID else { return }
        do {
            async let overview = api.callOverview(workspaceID: workspaceID)
            async let queue = api.callQueue(workspaceID: workspaceID)
            async let history = api.callHistory(workspaceID: workspaceID)
            state = .loaded(CallCenterData(
                overview: try await overview,
                queue: try await queue,
                history: try await history
            ))
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // Keep what we have.
        }
    }
}

struct CallCenterView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = CallCenterViewModel()

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        content
            .navigationTitle(Str.tabCalls(language))
            .navigationBarTitleDisplayMode(.inline)
            .floatingTabBarInset()
            .refreshable {
                await model.refresh(workspaceID: workspaceID, appState: appState)
            }
            .task(id: workspaceID) {
                await model.load(workspaceID: workspaceID, appState: appState)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed:
            ScrollView {
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: Str.offlineBody(language),
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await model.load(workspaceID: workspaceID, appState: appState) } }
                )
            }

        case .loaded(let data):
            List {
                Section {
                    StatGrid(overview: data.overview, language: language)
                        .listRowInsets(EdgeInsets(
                            top: Theme.Space.sm,
                            leading: Theme.screenInset,
                            bottom: Theme.Space.md,
                            trailing: Theme.screenInset
                        ))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }

                Section {
                    if data.queue.isEmpty {
                        QuietRow(text: Str.callsQueueEmpty(language))
                    } else {
                        ForEach(data.queue) { entry in
                            QueueRow(entry: entry, language: language)
                        }
                    }
                } header: {
                    Text(Str.callsQueueTitle(language))
                }

                Section {
                    if data.history.isEmpty {
                        QuietRow(text: Str.callsHistoryEmpty(language))
                    } else {
                        ForEach(data.history) { call in
                            CallRow(call: call, language: language, locale: locale)
                        }
                    }
                } header: {
                    Text(Str.callsRecentTitle(language))
                }
            }
            .listStyle(.insetGrouped)
        }
    }
}

// MARK: - Stats

/// The four numbers, two per row.
///
/// A fixed two-column grid rather than a horizontal scroll: four tiles fit a
/// phone, and a row that scrolls sideways hides half the numbers behind a
/// gesture nobody thinks to make.
struct StatGrid: View {
    let overview: CallOverview
    let language: Language

    private var tiles: [(String, Int, Color, String)] {
        [
            (Str.callsWaiting(language), overview.waitingCalls ?? 0, Theme.Palette.warning, "clock"),
            (Str.callsActive(language), overview.activeCalls ?? 0, Theme.Palette.success, "waveform"),
            (Str.callsToday(language), overview.todayCalls ?? 0, Theme.Palette.brand, "phone"),
            (Str.callsMissed(language), overview.missedToday ?? 0, Theme.Palette.danger, "phone.down"),
        ]
    }

    private let columns = [
        GridItem(.flexible(), spacing: Theme.Space.md),
        GridItem(.flexible(), spacing: Theme.Space.md),
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: Theme.Space.md) {
            ForEach(tiles, id: \.0) { title, value, tint, icon in
                StatTile(title: title, value: value, tint: tint, icon: icon)
            }
        }
    }
}

struct StatTile: View {
    let title: String
    let value: Int
    let tint: Color
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(spacing: Theme.Space.sm) {
                Image(systemName: icon)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(tint)
                Text(title)
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
            }

            Text("\(value)")
                .font(.system(.title, design: .rounded, weight: .semibold))
                // Monospaced digits keep the four tiles' numbers on the same
                // baseline width as they change.
                .monospacedDigit()
                .foregroundStyle(Theme.Palette.label)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Theme.Space.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Palette.surface)
        )
    }
}

// MARK: - Rows

/// Someone waiting. The wait time is the headline, because on a queue screen
/// it is the only number that decides what to do next.
struct QueueRow: View {
    let entry: QueueEntry
    let language: Language

    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var name: String {
        Format.contactName(
            name: entry.contactName,
            email: entry.contactEmail,
            visitorCode: entry.visitorCode,
            language: language
        )
    }

    private var waited: String {
        guard let seconds = entry.waitedSeconds(now: now) else { return "—" }
        return Format.duration(seconds)
    }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Avatar(name: name, imageURL: nil, size: Theme.Size.avatarSmall + 4)

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(name)
                    .font(Theme.Typo.rowTitle)
                    .lineLimit(1)

                if let channel = entry.channel, !channel.isEmpty {
                    Text(channel.capitalized)
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }
            }

            Spacer(minLength: Theme.Space.sm)

            Text(waited)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.Palette.warning)
                .environment(\.layoutDirection, .leftToRight)
        }
        .padding(.vertical, Theme.Space.xxs)
        .onReceive(tick) { now = $0 }
    }
}

/// A call that has happened. Missed calls are tinted, because that is the one
/// state worth spotting while scrolling.
struct CallRow: View {
    let call: CallRecord
    let language: Language
    let locale: Locale

    private var name: String {
        Format.contactName(
            name: call.contactName,
            email: nil,
            visitorCode: call.visitorCode,
            language: language
        )
    }

    private var icon: String {
        if call.wasMissed { return "phone.down.fill" }
        return call.direction?.lowercased() == "outbound" ? "phone.arrow.up.right.fill" : "phone.arrow.down.left.fill"
    }

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Image(systemName: icon)
                .font(.footnote)
                .foregroundStyle(call.wasMissed ? Theme.Palette.danger : Theme.Palette.labelSecondary)
                .frame(width: Theme.Space.xl)

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(name)
                    .font(Theme.Typo.rowTitle)
                    .foregroundStyle(call.wasMissed ? Theme.Palette.danger : Theme.Palette.label)
                    .lineLimit(1)

                HStack(spacing: Theme.Space.sm) {
                    Text(Format.listTimestamp(call.startedAt, locale: locale))
                    if let duration = call.duration, duration > 0 {
                        Text(Format.duration(duration))
                            .environment(\.layoutDirection, .leftToRight)
                    }
                }
                .font(Theme.Typo.meta)
                .foregroundStyle(Theme.Palette.labelSecondary)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, Theme.Space.xxs)
    }
}

/// A single muted line standing in for an empty section, rather than a
/// full-height empty state that would dwarf the sections around it.
struct QuietRow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Theme.Palette.labelSecondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, Theme.Space.sm)
            .listRowSeparator(.hidden)
    }
}
