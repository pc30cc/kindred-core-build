import SwiftUI

// MARK: - Transfer

/// Hands the conversation to somebody else, or back to the queue.
///
/// Suspended members are left out rather than shown greyed: the server
/// refuses them, and a row that cannot be tapped only invites the question of
/// why not.
struct TransferSheet: View {
    @Bindable var model: ConversationActionsModel
    let language: Language
    let currentUserID: String?

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task {
                            await model.assign(to: nil, appState: appState)
                            dismiss()
                        }
                    } label: {
                        row(
                            title: Str.unassigned(language),
                            subtitle: nil,
                            avatar: nil,
                            isCurrent: model.assignedTo == nil
                        )
                    }
                }

                Section {
                    ForEach(model.transferCandidates) { member in
                        Button {
                            Task {
                                await model.assign(to: member.userId, appState: appState)
                                dismiss()
                            }
                        } label: {
                            row(
                                title: member.userId == currentUserID
                                    ? "\(member.displayName) · \(Str.assignedToYou(language))"
                                    : member.displayName,
                                subtitle: member.profile?.email,
                                avatar: member.profile?.avatarURL,
                                isCurrent: model.assignedTo == member.userId
                            )
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(Str.transferConversation(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Str.cancel(language)) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(title: String, subtitle: String?, avatar: String?, isCurrent: Bool) -> some View {
        HStack(spacing: Theme.Space.md) {
            Avatar(name: title, imageURL: avatar, size: Theme.Size.avatarSmall + 4)

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(title)
                    .font(Theme.Typo.rowTitle)
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)

                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)
                        .latin()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            Spacer(minLength: Theme.Space.sm)

            if isCurrent {
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Palette.brand)
            }
        }
        .frame(minHeight: Theme.Size.minTouchTarget)
        .contentShape(Rectangle())
    }
}

// MARK: - Tags

struct TagsSheet: View {
    @Bindable var model: ConversationActionsModel
    let language: Language

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: Theme.Space.sm) {
                        Image(systemName: "number")
                            .foregroundStyle(Theme.Palette.labelSecondary)

                        TextField(Str.addTag(language), text: $draft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.done)
                            .focused($focused)
                            .onSubmit(add)

                        if !draft.isEmpty {
                            Button(action: add) {
                                Image(systemName: "plus.circle.fill")
                                    .foregroundStyle(Theme.Palette.brand)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .frame(minHeight: Theme.Size.minTouchTarget - 10)
                }

                Section {
                    if model.tags.isEmpty {
                        Text(Str.noTags(language))
                            .font(Theme.Typo.rowSubtitle)
                            .foregroundStyle(Theme.Palette.labelSecondary)
                    } else {
                        ForEach(model.tags, id: \.self) { tag in
                            HStack(spacing: Theme.Space.sm) {
                                Image(systemName: "tag.fill")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.Palette.brand)
                                Text(tag)
                                    .font(Theme.Typo.rowTitle)
                                Spacer(minLength: 0)
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    Task { await model.removeTag(tag, appState: appState) }
                                } label: {
                                    Image(systemName: "trash")
                                }
                            }
                        }
                    }
                } header: {
                    Text(Str.tags(language))
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(Str.tags(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(Str.done(language)) { dismiss() }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func add() {
        let tag = draft
        draft = ""
        Task { await model.addTag(tag, appState: appState) }
    }
}

// MARK: - Internal notes

/// What the team says about a conversation, which the visitor never sees.
///
/// The warning at the top is not decoration: an operator who mistakes this
/// for the composer publishes an internal remark to a customer, and that is
/// the kind of mistake a product should make structurally hard.
struct NotesSheet: View {
    @Bindable var model: ConversationActionsModel
    let language: Language
    let locale: Locale

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            list
                .navigationTitle(Str.internalNotes(language))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(Str.done(language)) { dismiss() }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    composer
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private var list: some View {
        List {
            Section {
                Label(Str.notesPrivacyNote(language), systemImage: "lock.fill")
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
            }

            Section {
                switch model.notes {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity)

                // A list that failed to load and one that is genuinely empty
                // read the same to an operator, and neither is worth an error
                // banner over a feature that is nice to have.
                case .failed:
                    emptyNotes

                case .loaded(let notes):
                    if notes.isEmpty {
                        emptyNotes
                    } else {
                        ForEach(notes) { note in
                            NoteRow(note: note, language: language, locale: locale)
                                .swipeActions {
                                    Button(role: .destructive) {
                                        Task { await model.deleteNote(note, appState: appState) }
                                    } label: {
                                        Image(systemName: "trash")
                                    }
                                }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var emptyNotes: some View {
        Text(Str.noNotes(language))
            .font(Theme.Typo.rowSubtitle)
            .foregroundStyle(Theme.Palette.labelSecondary)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: Theme.Space.sm) {
            TextField(Str.writeNote(language), text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, Theme.Space.md)
                .padding(.vertical, Theme.Space.sm)
                .background(Capsule().fill(Theme.Palette.surfaceElevated))
                .focused($focused)

            SendButton(
                isEnabled: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                isSending: model.isSaving,
                label: Str.send(language)
            ) {
                let text = draft
                draft = ""
                Task { await model.addNote(text, appState: appState) }
            }
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.sm)
        .background(.bar)
    }
}

struct NoteRow: View {
    let note: ConversationNote
    let language: Language
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.sm) {
                if !note.authorName.isEmpty {
                    Text(note.authorName)
                        .font(Theme.Typo.metaEmphasis)
                        .foregroundStyle(Theme.Palette.label)
                }
                Spacer(minLength: Theme.Space.xs)
                if let createdAt = note.createdAt {
                    Text(Format.listTimestamp(createdAt, locale: locale))
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }

            Text(note.body)
                .font(Theme.Typo.message)
                .foregroundStyle(Theme.Palette.label)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, Theme.Space.xxs)
    }
}
