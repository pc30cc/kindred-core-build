import SwiftUI

/// Who is asking, drawn: the card at the top of a platform-support
/// conversation in the support team's inbox.
///
/// The person first — a face, a name, the addresses to reach them at (tap to
/// write or call), the app they wrote from — then each of their workspaces as
/// a panel of its own: its plan with the day it was bought and the day it
/// runs out, how far through that period it is, and what it has used against
/// its limits. Only the support team sees it; it says so.
struct RequesterCardView: View {
    let card: RequesterCard
    let language: Language

    @Environment(\.openURL) private var openURL

    private var locale: Locale { language.locale }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            person
                .padding(Theme.Space.md)
            if !card.workspaces.isEmpty {
                Divider()
                workspaces
                    .padding(Theme.Space.md)
            }
            if let captured = card.capturedAt {
                Divider()
                footer(captured)
            }
        }
        .background(Theme.Palette.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .strokeBorder(Theme.Palette.separator.opacity(0.7), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.05), radius: 6, x: 0, y: 2)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Space.sm)
        .environment(\.layoutDirection, language.layoutDirection)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.supportRequesterCard)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: "person.text.rectangle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Theme.Palette.brand))
            VStack(alignment: .leading, spacing: 1) {
                Text(RequesterStr.title(language))
                    .font(.app(.subheadline, .semibold))
                    .foregroundStyle(Theme.Palette.label)
                HStack(spacing: 3) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 8, weight: .semibold))
                    Text(RequesterStr.teamOnly(language))
                        .font(.app(.caption2))
                        .lineLimit(1)
                }
                .foregroundStyle(Theme.Palette.labelTertiary)
            }
            Spacer(minLength: Theme.Space.xs)
            ChannelLabel(
                key: ConversationChannel.platformSupport,
                language: language,
                platform: card.clientPlatform,
                compact: true
            )
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .background(Theme.Palette.brand.opacity(0.06))
    }

    // MARK: The person

    private var person: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(alignment: .top, spacing: Theme.Space.md) {
                MailAvatar(address: card.email ?? card.name ?? "?", size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.name ?? card.email ?? "—")
                        .font(.app(.headline))
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(2)
                    if let company = card.company {
                        Label(company, systemImage: "briefcase.fill")
                            .font(.app(.footnote))
                            .foregroundStyle(Theme.Palette.labelSecondary)
                            .labelStyle(TightLabel())
                    }
                }
                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                if let email = card.email {
                    contact(email, icon: "envelope.fill", url: URL(string: "mailto:\(email)"))
                }
                if let phone = card.phone {
                    let digits = phone.filter { $0.isNumber || $0 == "+" }
                    contact(phone, icon: "phone.fill", url: URL(string: "tel:\(digits)"))
                }
                if let website = card.website {
                    contact(website, icon: "globe", url: URL(string: website.hasPrefix("http") ? website : "https://\(website)"))
                }
            }

            let facts = personFacts
            if !facts.isEmpty {
                Flow(spacing: Theme.Space.xs) {
                    ForEach(facts) { fact in
                        Chip(icon: fact.icon, text: fact.text)
                    }
                }
            }
        }
    }

    private struct Fact: Identifiable {
        let icon: String
        let text: String
        var id: String { text }
    }

    private var personFacts: [Fact] {
        var facts: [Fact] = []
        if let since = card.memberSince {
            facts.append(Fact(icon: "calendar", text: RequesterStr.memberSince(language, Format.fullDate(since, locale: locale))))
        }
        if let source = card.sourceWorkspace {
            facts.append(Fact(icon: "arrow.turn.down.right", text: RequesterStr.from(language, source)))
        }
        return facts
    }

    /// An address or a number: left to right in every language, and a tap
    /// away from writing or calling.
    private func contact(_ text: String, icon: String, url: URL?) -> some View {
        Button {
            if let url { openURL(url) }
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Palette.brand)
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(Theme.Palette.brand.opacity(0.12)))
                Text(text)
                    .font(.app(.subheadline))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .environment(\.layoutDirection, .leftToRight)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(url == nil)
    }

    // MARK: Workspaces

    private var workspaces: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(spacing: Theme.Space.xs) {
                Image(systemName: "square.stack.3d.up.fill")
                    .font(.system(size: 11, weight: .semibold))
                Text(RequesterStr.workspaces(language, card.workspaceCount))
                    .font(.app(.footnote, .semibold))
            }
            .foregroundStyle(Theme.Palette.labelSecondary)

            ForEach(card.workspaces) { workspace in
                WorkspacePanel(workspace: workspace, language: language)
            }

            let more = card.workspaceCount - card.workspaces.count
            if more > 0 {
                Text(RequesterStr.more(language, more))
                    .font(.app(.caption))
                    .foregroundStyle(Theme.Palette.labelTertiary)
            }
        }
    }

    private func footer(_ captured: Date) -> some View {
        HStack(spacing: Theme.Space.xs) {
            Image(systemName: "clock")
                .font(.system(size: 10))
            Text(RequesterStr.asOf(
                language,
                "\(Format.fullDate(captured, locale: locale)) · \(Format.bubbleTime(captured, locale: locale))"
            ))
            .font(.app(.caption2))
        }
        .foregroundStyle(Theme.Palette.labelTertiary)
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - One workspace

private struct WorkspacePanel: View {
    let workspace: RequesterCard.Workspace
    let language: Language

    private var locale: Locale { language.locale }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(spacing: Theme.Space.sm) {
                Image(systemName: "building.2.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Palette.brand)
                    .frame(width: 30, height: 30)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.Palette.brand.opacity(0.12)))
                Text(workspace.name)
                    .font(.app(.subheadline, .semibold))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                Spacer(minLength: Theme.Space.xs)
                if let role = workspace.role {
                    Pill(text: RequesterStr.role(language, role), tint: Theme.Palette.labelSecondary)
                }
            }

            if let plan = workspace.plan {
                PlanPanel(plan: plan, language: language)
            } else {
                Label(RequesterStr.noPlan(language), systemImage: "minus.circle")
                    .font(.app(.footnote))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .labelStyle(TightLabel())
            }

            usage
        }
        .padding(Theme.Space.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Palette.background)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .strokeBorder(Theme.Palette.separator.opacity(0.5), lineWidth: 0.5)
        )
    }

    private var usage: some View {
        let columns = [GridItem(.flexible(), spacing: Theme.Space.sm), GridItem(.flexible(), spacing: Theme.Space.sm)]
        return VStack(alignment: .leading, spacing: Theme.Space.xs) {
            Text(RequesterStr.usageThisMonth(language))
                .font(.app(.caption, .semibold))
                .foregroundStyle(Theme.Palette.labelSecondary)
            LazyVGrid(columns: columns, alignment: .leading, spacing: Theme.Space.sm) {
                UsageTile(icon: "bubble.left.and.bubble.right.fill", label: RequesterStr.conversations(language),
                          value: metered(workspace.conversations), fraction: workspace.conversations.fraction)
                UsageTile(icon: "eye.fill", label: RequesterStr.visitors(language),
                          value: metered(workspace.visitors), fraction: workspace.visitors.fraction)
                UsageTile(icon: "sparkles", label: RequesterStr.aiCredits(language),
                          value: metered(workspace.aiCredits), fraction: workspace.aiCredits.fraction)
                UsageTile(icon: "text.bubble.fill", label: RequesterStr.messages(language),
                          value: number(workspace.messages), fraction: nil)
                UsageTile(icon: "person.2.fill", label: RequesterStr.operators(language),
                          value: metered(workspace.operators), fraction: workspace.operators.fraction)
                UsageTile(icon: "person.crop.rectangle.stack.fill", label: RequesterStr.contacts(language),
                          value: metered(workspace.contacts), fraction: workspace.contacts.fraction)
                UsageTile(icon: "internaldrive.fill", label: RequesterStr.storage(language),
                          value: storage, fraction: workspace.storage.fraction)
            }
        }
    }

    private func number(_ value: Double) -> String {
        Format.number(Int(value.rounded()), language: language)
    }

    private func metered(_ value: RequesterCard.Metered) -> String {
        let used = number(value.used)
        guard let limit = value.limit else { return used }
        return limit < 0 ? "\(used) / ∞" : "\(used) / \(number(limit))"
    }

    private var storage: String {
        let used = Format.fileSize(Int(workspace.storageBytes), language: language)
        guard let limit = workspace.storageLimitGB else { return used }
        return limit < 0 ? "\(used) / ∞" : "\(used) / \(number(limit)) GB"
    }
}

// MARK: - The plan

/// The plan in a tinted panel: its name and state, the day it was bought and
/// the day it runs out side by side, a bar of how much of the period is
/// gone, and how many days are left.
private struct PlanPanel: View {
    let plan: RequesterCard.Plan
    let language: Language

    private var locale: Locale { language.locale }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(spacing: Theme.Space.xs) {
                Image(systemName: plan.isFree ? "leaf.fill" : "crown.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Palette.brand)
                Text(plan.title(language))
                    .font(.app(.subheadline, .bold))
                    .foregroundStyle(Theme.Palette.brand)
                    .lineLimit(1)
                if let status = plan.status {
                    Pill(text: RequesterStr.status(language, status), tint: statusTint(status))
                } else if plan.isFree {
                    Pill(text: RequesterStr.free(language), tint: Theme.Palette.labelSecondary)
                }
                Spacer(minLength: 0)
                if let interval = plan.billingInterval.flatMap({ RequesterStr.interval(language, $0) }) {
                    Text(interval)
                        .font(.app(.caption))
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }
            }

            if plan.periodStart != nil || plan.endsAt != nil {
                HStack(alignment: .top, spacing: 0) {
                    dateColumn(
                        icon: "cart.fill",
                        label: RequesterStr.purchased(language),
                        date: plan.periodStart
                    )
                    Rectangle()
                        .fill(Theme.Palette.separator)
                        .frame(width: 0.5, height: 34)
                        .padding(.horizontal, Theme.Space.sm)
                    dateColumn(
                        icon: "calendar.badge.clock",
                        label: plan.isTrial ? RequesterStr.trialEnds(language) : RequesterStr.expires(language),
                        date: plan.endsAt
                    )
                }

                if let elapsed = plan.elapsed() {
                    ProgressView(value: elapsed)
                        .progressViewStyle(.linear)
                        .tint(remainingTint)
                        .accessibilityHidden(true)
                }

                HStack(spacing: Theme.Space.xs) {
                    if let left = remaining {
                        Text(left)
                            .font(.app(.caption, .semibold))
                            .foregroundStyle(remainingTint)
                    }
                    Spacer(minLength: 0)
                    if plan.periodEnd != nil, !plan.isTrial {
                        Label(
                            plan.cancelAtPeriodEnd ? RequesterStr.wontRenew(language) : RequesterStr.renewsAutomatically(language),
                            systemImage: plan.cancelAtPeriodEnd ? "xmark.circle" : "arrow.triangle.2.circlepath"
                        )
                        .font(.app(.caption2))
                        .foregroundStyle(plan.cancelAtPeriodEnd ? Theme.Palette.warning : Theme.Palette.labelSecondary)
                        .labelStyle(TightLabel())
                    }
                }
            }

            if let started = plan.startedAt {
                Text(RequesterStr.customerSince(language, Format.fullDate(started, locale: locale)))
                    .font(.app(.caption2))
                    .foregroundStyle(Theme.Palette.labelTertiary)
            }
        }
        .padding(Theme.Space.sm + 2)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.sm + 2, style: .continuous)
                .fill(Theme.Palette.brand.opacity(0.07))
        )
    }

    private func dateColumn(icon: String, label: String, date: Date?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(label, systemImage: icon)
                .font(.app(.caption2))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .labelStyle(TightLabel())
            Text(date.map { Format.fullDate($0, locale: locale) } ?? "—")
                .font(.app(.footnote, .semibold))
                .foregroundStyle(Theme.Palette.label)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var remaining: String? {
        guard let days = plan.daysLeft() else { return nil }
        if days > 0 { return RequesterStr.daysLeft(language, days) }
        if days == 0 { return RequesterStr.endsToday(language) }
        return RequesterStr.expiredAgo(language, -days)
    }

    private var remainingTint: Color {
        guard let days = plan.daysLeft() else { return Theme.Palette.brand }
        if days <= 0 { return Theme.Palette.danger }
        if days <= 7 { return Theme.Palette.warning }
        return Theme.Palette.success
    }

    private func statusTint(_ status: String) -> Color {
        switch status {
        case "active": Theme.Palette.success
        case "trialing": Theme.Palette.brand
        case "past_due": Theme.Palette.warning
        case "canceled", "cancelled", "expired": Theme.Palette.danger
        default: Theme.Palette.labelSecondary
        }
    }
}

// MARK: - Pieces

/// One use against its limit: its mark, its name, the numbers, and a bar
/// that turns orange, then red, as the limit comes near.
private struct UsageTile: View {
    let icon: String
    let label: String
    let value: String
    let fraction: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.Palette.labelTertiary)
                Text(label)
                    .font(.app(.caption2))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            Text(value)
                .font(.app(.footnote, .semibold))
                .foregroundStyle(Theme.Palette.label)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .environment(\.layoutDirection, .leftToRight)
            if let fraction {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.Palette.separator.opacity(0.5))
                        Capsule()
                            .fill(tint(fraction))
                            .frame(width: max(3, proxy.size.width * fraction))
                    }
                }
                .frame(height: 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func tint(_ fraction: Double) -> Color {
        if fraction >= 0.9 { return Theme.Palette.danger }
        if fraction >= 0.7 { return Theme.Palette.warning }
        return Theme.Palette.brand
    }
}

private struct Pill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.app(.caption2, .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(tint.opacity(0.14)))
            .lineLimit(1)
            .fixedSize()
    }
}

private struct Chip: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 9, weight: .semibold))
            Text(text)
                .font(.app(.caption))
                .lineLimit(1)
        }
        .foregroundStyle(Theme.Palette.labelSecondary)
        .padding(.horizontal, Theme.Space.sm)
        .padding(.vertical, 4)
        .background(Capsule().fill(Theme.Palette.surfaceElevated))
    }
}

/// A label with its icon close to its words.
private struct TightLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}

/// Chips in rows, wrapping to the next when a row is full.
private struct Flow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var row: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: width, height: nil))
            if x > 0, x + size.width > width {
                x = 0
                y += row + spacing
                row = 0
            }
            x += size.width + spacing
            row = max(row, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + row)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var row: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += row + spacing
                row = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
            x += size.width + spacing
            row = max(row, size.height)
        }
    }
}
