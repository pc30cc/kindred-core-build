import SwiftUI

/// Looks a conversation up by the three things that actually identify one.
///
/// Deliberately not more fields. Queue and status already have their own
/// control at the top of the list, and a sheet that repeats them would let an
/// operator set two contradictory filters and then wonder where their
/// conversations went.
struct InboxFilterSheet: View {
    @Binding var filter: InboxFieldFilter
    let language: Language

    @Environment(\.dismiss) private var dismiss
    @State private var draft: InboxFieldFilter
    @FocusState private var focused: Field?

    private enum Field: Hashable { case name, email, subject }

    init(filter: Binding<InboxFieldFilter>, language: Language) {
        _filter = filter
        self.language = language
        _draft = State(initialValue: filter.wrappedValue)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    field(
                        title: Str.filterByName(language),
                        text: $draft.name,
                        field: .name,
                        icon: "person"
                    )
                    field(
                        title: Str.filterByEmail(language),
                        text: $draft.email,
                        field: .email,
                        icon: "envelope",
                        keyboard: .emailAddress,
                        // An address is an LTR string in every language, and
                        // reading one right-to-left is genuinely confusing.
                        forceLTR: true
                    )
                    field(
                        title: Str.filterBySubject(language),
                        text: $draft.subject,
                        field: .subject,
                        icon: "text.alignleft"
                    )
                }
            }
            .navigationTitle(Str.filters(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Str.clearFilters(language)) {
                        draft = InboxFieldFilter()
                    }
                    .disabled(draft.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(Str.apply(language)) {
                        filter = draft
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .onAppear { focused = .name }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private func field(
        title: String,
        text: Binding<String>,
        field: Field,
        icon: String,
        keyboard: UIKeyboardType = .default,
        forceLTR: Bool = false
    ) -> some View {
        HStack(spacing: Theme.Space.md) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .frame(width: 22)

            TextField(title, text: text)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($focused, equals: field)
                .latin(forceLTR)
                .frame(maxWidth: .infinity, alignment: .leading)

            if !text.wrappedValue.isEmpty {
                Button {
                    text.wrappedValue = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: "×"))
            }
        }
        .frame(minHeight: Theme.Size.minTouchTarget - 10)
    }
}
