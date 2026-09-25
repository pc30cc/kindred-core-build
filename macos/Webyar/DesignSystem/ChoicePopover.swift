import SwiftUI

/// One option in a `ChoiceList`: its words, and what sits before them — a
/// coloured dot, a symbol, or a person's avatar — with an optional line under.
struct Choice: Identifiable {
    let id: String
    let title: String
    var hint: String? = nil
    var dot: Color? = nil
    var systemImage: String? = nil
    var tint: Color? = nil
    /// A person: their name and photo, drawn as every operator avatar is.
    var person: (name: String, photo: String?)? = nil
}

/// A short list to pick one from, drawn in SwiftUI rather than as an AppKit
/// menu so it reads right to left in Persian: a title, an optional search,
/// and rows that tick the current one.
struct ChoiceList: View {
    var title: String? = nil
    let choices: [Choice]
    let selected: String?
    var searchable = false
    let pick: (String) -> Void
    @Environment(AppModel.self) private var app
    @State private var query = ""

    var body: some View {
        let s = app.strings
        let shown = query.isEmpty ? choices : choices.filter { $0.title.localizedCaseInsensitiveContains(query) }
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                Text(title).appFont(11.5, .semibold).foregroundStyle(Palette.text3)
                    .padding(.horizontal, 8)
                    .padding(.top, 2)
            }
            if searchable {
                SearchField(prompt: s["search"], text: $query).padding(.bottom, 2)
            }
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(shown) { choice in
                        ChoiceRow(choice: choice, selected: choice.id == selected) { pick(choice.id) }
                    }
                    if shown.isEmpty {
                        Text(s["noResults"]).appFont(12).foregroundStyle(Palette.text2).padding(10)
                    }
                }
            }
            .frame(maxHeight: 320)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(width: 280)
        // A popover is a window of its own: give it the language's direction outright.
        .environment(\.layoutDirection, s.isRightToLeft ? .rightToLeft : .leftToRight)
    }
}

private struct ChoiceRow: View {
    let choice: Choice
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: choice.hint == nil ? .center : .top, spacing: 10) {
                leading
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.title)
                        .appFont(13, selected ? .semibold : .regular)
                        .foregroundStyle(selected ? Palette.brand : Palette.text)
                        .lineLimit(1)
                    if let hint = choice.hint {
                        Text(hint).appFont(11).foregroundStyle(Palette.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.brand)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hovering ? Palette.hover : selected ? Palette.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }

    @ViewBuilder private var leading: some View {
        if let person = choice.person {
            AvatarView(name: person.name, imageURL: person.photo, size: 24, kind: .operator)
        } else if let dot = choice.dot {
            Circle().fill(dot).frame(width: 9, height: 9).frame(width: 18, height: 18)
        } else if let image = choice.systemImage {
            Image(systemName: image)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(choice.tint ?? Palette.text2)
                .frame(width: 18, height: 18)
        }
    }
}

/// A details line whose value can be changed: the label, then the current
/// value as a button that opens a `ChoiceList` beside it.
struct ChoiceField: View {
    let label: String
    let value: String
    var valueColor: Color = Palette.text
    var leading: Choice? = nil
    let choices: [Choice]
    let selected: String?
    var searchable = false
    var disabled = false
    let pick: (String) -> Void
    @Environment(AppModel.self) private var app
    @State private var open = false
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            Text(label).appFont(12).foregroundStyle(Palette.text2)
            Spacer(minLength: 8)
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    if let person = leading?.person {
                        AvatarView(name: person.name, imageURL: person.photo, size: 18, kind: .operator)
                    } else if let dot = leading?.dot {
                        Circle().fill(dot).frame(width: 7, height: 7)
                    }
                    Text(value).appFont(12.5, .semibold).foregroundStyle(valueColor).lineLimit(1).truncationMode(.tail)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Palette.text3)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hovering || open ? Palette.hover : .clear))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            .onHover { hovering = $0 }
            .popover(isPresented: $open, arrowEdge: .bottom) {
                ChoiceList(title: label, choices: choices, selected: selected, searchable: searchable) { id in
                    open = false
                    if id != selected { pick(id) }
                }
                .environment(app)
                .appEnvironment(app)
            }
        }
    }
}
