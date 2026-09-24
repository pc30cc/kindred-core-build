import SwiftUI

/// Which sheet the conversation menu opened.
enum ConversationSheet: String, Identifiable {
    case transfer, tags, notes
    var id: String { rawValue }
}

/// The three-line menu in the chat header.
///
/// Everything an operator does to a conversation rather than in it: who owns
/// it, what state it is in, how it is labelled, what the team should know
/// about it, and — when the plan allows — asking the visitor onto a call.
///
/// The call entries are gated the same way `SidebarCallCard` gates its
/// buttons, down to reading "not explicitly false" as allowed. A button the
/// server would answer with `plan_forbidden` is never drawn.
struct ConversationMenu: View {
    @Bindable var model: ConversationActionsModel
    let channels: CallChannels
    let language: Language
    @Binding var sheet: ConversationSheet?
    let onStatus: (ConversationStatus) -> Void
    let onPriority: (ConversationPriority) -> Void
    let onInvite: (CallChannel) -> Void
    /// Whether the AI still owns this thread. Take-over is the first row when
    /// it does and absent when it does not — offering to take over a
    /// conversation already in human hands is an action with nothing to do.
    var isAIManaged: Bool = false
    var onTakeOver: () -> Void = {}
    /// `true` to quarantine the thread, `false` to let it back out.
    var onSpam: (Bool) -> Void = { _ in }

    /// Whether the call section has anything in it at all. Without this the
    /// section renders empty on an AI-managed thread -- a divider with
    /// nothing under it.
    private var canCall: Bool {
        (channels.voice || channels.video) && !isAIManaged
    }

    var body: some View {
        Menu {
            if isAIManaged {
                // Its own section, above everything: an operator opening this
                // menu on an AI thread is usually here to get into it, and
                // that should not be the fifth row down.
                Section {
                    Button {
                        onTakeOver()
                    } label: {
                        Label(Str.takeOver(language), systemImage: "hand.raised.fill")
                    }
                }
            }

            Section {
                Button {
                    sheet = .transfer
                } label: {
                    Label(transferLabel, systemImage: "arrow.left.arrow.right")
                }

                Menu {
                    ForEach(ConversationStatus.selectable, id: \.self) { status in
                        Button {
                            onStatus(status)
                        } label: {
                            // A checkmark rather than a `Picker`: the value
                            // only changes once the server has taken it, and a
                            // picker's binding would claim it already had.
                            Label(
                                status.title(language),
                                systemImage: status == model.status ? "checkmark" : ""
                            )
                        }
                    }
                } label: {
                    Label(
                        "\(Str.changeStatus(language)) · \(model.status.title(language))",
                        systemImage: "circle.lefthalf.filled"
                    )
                }

                Menu {
                    ForEach(ConversationPriority.selectable, id: \.self) { priority in
                        Button {
                            onPriority(priority)
                        } label: {
                            Label(
                                priority.title(language),
                                systemImage: priority == model.priority ? "checkmark" : ""
                            )
                        }
                    }
                } label: {
                    Label(
                        "\(Str.changePriority(language)) · \(model.priority.title(language))",
                        systemImage: "flag"
                    )
                }
            }

            Section {
                Button {
                    sheet = .tags
                } label: {
                    Label(tagsLabel, systemImage: "tag")
                }

                Button {
                    sheet = .notes
                } label: {
                    Label(notesLabel, systemImage: "note.text")
                }
            }

            // On its own, at the bottom, destructive.
            //
            // It reaches further than its name: the server flags the contact,
            // which pulls their other threads in and keeps future ones out of
            // the main queue. That is why it is red, why it is last, and why
            // the screen says what happened afterwards rather than letting a
            // menu row be the whole explanation.
            Section {
                if model.isSpam {
                    Button {
                        onSpam(false)
                    } label: {
                        Label(Str.notSpam(language), systemImage: "tray.and.arrow.up")
                    }
                } else {
                    Button(role: .destructive) {
                        onSpam(true)
                    } label: {
                        Label(Str.markSpam(language), systemImage: "exclamationmark.octagon")
                    }
                }
            }

            // Only drawn when the plan grants it AND the thread is the
            // operator's to act on.
            //
            // An operator on a plan without calls never learns the buttons
            // exist, which is the behaviour the web sidebar already has. The
            // second half is the AI queue: while the assistant owns a thread
            // there is no operator on this end to put on a call, so offering
            // one is offering something that cannot happen. Taking the thread
            // over clears `isAIManaged`, and the buttons arrive with it --
            // which is the right moment, because that is when there is
            // somebody to talk.
            if canCall {
                Section {
                    if channels.voice && !isAIManaged {
                        Button {
                            onInvite(.audio)
                        } label: {
                            Label(Str.voiceCall(language), systemImage: CallChannel.audio.icon)
                        }
                    }
                    if channels.video && !isAIManaged {
                        Button {
                            onInvite(.video)
                        } label: {
                            Label(Str.videoCall(language), systemImage: CallChannel.video.icon)
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 17, weight: .medium))
        }
        .accessibilityLabel(Str.conversationActions(language))
        .accessibilityIdentifier(A11y.conversationMenu)
    }

    /// Menus read better when the current value is part of the row, so the
    /// operator does not have to open a submenu to find out what it is.
    private var transferLabel: String {
        // No "· Unassigned" suffix: a menu row is about 22 characters wide
        // before it hyphenates mid-word, and "nobody owns this" is already
        // what an operator assumes when they go looking for Transfer.
        guard let name = model.assigneeName else { return Str.transferConversation(language) }
        return "\(Str.transferConversation(language)) · \(name)"
    }

    private var tagsLabel: String {
        model.tags.isEmpty
            ? Str.tags(language)
            : "\(Str.tags(language)) · \(model.tags.count)"
    }

    private var notesLabel: String {
        let count = model.notes.value?.count ?? 0
        return count == 0
            ? Str.internalNotes(language)
            : "\(Str.internalNotes(language)) · \(count)"
    }
}

// MARK: - Titles

extension ConversationStatus {
    /// The four the server accepts, in the order the web lists them.
    static var selectable: [ConversationStatus] { [.open, .pending, .resolved, .closed] }

    func title(_ language: Language) -> String {
        switch self {
        case .open: Str.filterOpen(language)
        case .pending: Str.statusPending(language)
        case .resolved: Str.filterResolved(language)
        case .closed: Str.statusClosed(language)
        }
    }
}

extension ConversationPriority {
    /// Lowest to highest, the order the web's picker uses.
    static var selectable: [ConversationPriority] { [.low, .normal, .high, .urgent] }

    func title(_ language: Language) -> String {
        switch self {
        case .low: Str.priorityLow(language)
        case .normal: Str.priorityNormal(language)
        case .high: Str.priorityHigh(language)
        case .urgent: Str.priorityUrgent(language)
        }
    }
}
