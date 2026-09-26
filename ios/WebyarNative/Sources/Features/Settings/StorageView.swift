import SwiftUI

/// What the app keeps on this phone, and the one button that empties it.
///
/// Everything counted here is a copy: saved conversations so the inbox and a
/// thread open at once and offline, files so a photo or a voice note is not
/// downloaded twice, and pictures (faces, logos). Clearing it removes the
/// copies and nothing else — not a message on the server, not the session,
/// not a setting — and the app fills it again from the server as it is used.
struct StorageView: View {
    @Environment(AppState.self) private var appState

    @State private var usage: StorageUsage?
    @State private var isConfirming = false
    @State private var isClearing = false

    private var language: Language { appState.language }

    var body: some View {
        List {
            Section {
                DetailRow(label: Str.storageConversations(language), value: size(usage?.messages))
                DetailRow(label: Str.storageFiles(language), value: size(usage?.files))
                DetailRow(label: Str.storagePictures(language), value: size(usage?.pictures))
                DetailRow(label: Str.storageTotal(language), value: size(usage?.total))
            } footer: {
                Text(Str.storageFooter(language))
            }

            Section {
                Button(role: .destructive) {
                    isConfirming = true
                } label: {
                    HStack {
                        Text(Str.clearCache(language))
                            .foregroundStyle(Theme.Palette.danger)
                        Spacer(minLength: Theme.Space.sm)
                        if isClearing { ProgressView() }
                    }
                }
                .disabled(isClearing)
                .accessibilityIdentifier(A11y.clearCache)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(Str.storage(language))
        .navigationBarTitleDisplayMode(.inline)
        .task { await measure() }
        .confirmationDialog(
            Str.clearCacheConfirm(language),
            isPresented: $isConfirming,
            titleVisibility: .visible
        ) {
            Button(Str.clearCache(language), role: .destructive) { clear() }
            Button(Str.cancel(language), role: .cancel) {}
        }
    }

    private func size(_ bytes: Int64?) -> String {
        guard let bytes else { return "…" }
        return Format.fileSize(Int(clamping: bytes), language: language)
    }

    private func measure() async {
        usage = await SyncCoordinator.shared.storageUsage()
    }

    private func clear() {
        isClearing = true
        Task {
            // What is on screen elsewhere stays until its next read: nothing
            // collapses under the operator, and a voice note playing keeps
            // playing (its file is held open until it stops).
            await SyncCoordinator.shared.clearCache()
            await measure()
            isClearing = false
        }
    }
}
