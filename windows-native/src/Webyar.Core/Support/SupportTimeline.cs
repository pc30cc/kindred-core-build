namespace Webyar.Core.Support;

/// <summary>
/// A picked file on its way to the team. Not a record: two uploads are the
/// same only if they are the same object, never because their bytes match.
/// </summary>
public sealed class SupportUpload(byte[] data, string fileName, string mimeType)
{
    public byte[] Data { get; } = data;
    public string FileName { get; } = fileName;
    public string MimeType { get; } = mimeType;
}

/// <summary>A message or file the operator sent that the server has not confirmed yet.</summary>
/// <param name="ClientMessageId">Minted once; every attempt carries it, so a retry is the same message.</param>
/// <param name="File">Held until it lands — a retry sends these same bytes.</param>
/// <param name="ConversationId">The open conversation it was written to; null for the first message of a new one.</param>
public sealed record PendingSupportItem(
    string ClientMessageId,
    string Body,
    DateTimeOffset CreatedAt,
    SupportUpload? File = null,
    bool Failed = false,
    string? ConversationId = null);

public enum SupportRowKind { NewConversation, Joined, Bubble, Ended, Rating }

/// <summary>
/// One row of the support chat, worked out once for the whole list so a row
/// never has to look at its neighbours while it draws.
/// </summary>
public sealed record SupportRow(
    SupportRowKind Kind,
    string Key,
    SupportItem? Item = null,
    PendingSupportItem? Pending = null,
    SupportConversation? Conversation = null,
    bool Mine = false,
    DateTimeOffset? Time = null,
    // Set on the first row of a day: the header goes above it.
    DateTimeOffset? DayHeader = null,
    bool StartsRun = false,
    bool EndsRun = false)
{
    /// <summary>Who a run belongs to: the operator, or one agent of the team.</summary>
    public string Sender => Mine ? "me" : "team:" + (Item?.SenderName ?? string.Empty);
}

public static class SupportTimeline
{
    /// <summary>
    /// The conversations given, in order, each followed by how it ended and
    /// its rating, then whatever the operator is still sending. What is on
    /// its way to a new conversation sits under its own "new conversation"
    /// line, below any ended one and never inside it. A day header goes above
    /// the first message of each day — except right under a "new
    /// conversation" line, which carries the date already. An item whose
    /// conversation is not given is left out.
    /// </summary>
    public static IReadOnlyList<SupportRow> Build(
        IReadOnlyList<SupportConversation> conversations,
        IReadOnlyList<SupportItem> items,
        IReadOnlyList<PendingSupportItem> pending,
        TimeZoneInfo? zone = null)
    {
        zone ??= TimeZoneInfo.Local;
        var rows = new List<SupportRow>();
        DateTime? lastDay = null;
        DateTime? DayOf(DateTimeOffset? t) => t is { } v ? TimeZoneInfo.ConvertTime(v, zone).Date : null;
        DateTimeOffset? Header(DateTimeOffset? time)
        {
            var day = DayOf(time);
            if (day is null || day == lastDay) return null;
            lastDay = day;
            return time;
        }

        var byConversation = items.GroupBy(i => i.ConversationId).ToDictionary(g => g.Key, g => g.ToList());
        for (var index = 0; index < conversations.Count; index++)
        {
            var c = conversations[index];
            if (index > 0)
            {
                rows.Add(new SupportRow(SupportRowKind.NewConversation, "new-" + c.Id, Conversation: c, Time: c.CreatedAt));
                if (DayOf(c.CreatedAt) is { } d) lastDay = d;
            }
            foreach (var item in byConversation.TryGetValue(c.Id, out var list) ? list : [])
            {
                if (item.IsJoin)
                    rows.Add(new SupportRow(SupportRowKind.Joined, item.Id, Item: item, Time: item.CreatedAt, DayHeader: Header(item.CreatedAt)));
                else if (!string.IsNullOrWhiteSpace(item.Body) || item.Files.Count > 0)
                    rows.Add(new SupportRow(SupportRowKind.Bubble, item.ClientMessageId is { Length: > 0 } cid ? "c-" + cid : item.Id,
                        Item: item, Mine: !item.FromTeam, Time: item.CreatedAt, DayHeader: Header(item.CreatedAt)));
            }
            if (c.Ended)
            {
                rows.Add(new SupportRow(SupportRowKind.Ended, "ended-" + c.Id, Conversation: c));
                if (c.CanRate || c.Rating is not null) rows.Add(new SupportRow(SupportRowKind.Rating, "rating-" + c.Id, Conversation: c));
            }
        }

        // Once the server has it, its own copy is the one shown.
        var delivered = items.Select(i => i.ClientMessageId).Where(id => id is not null).ToHashSet();
        var waiting = pending.Where(p => !delivered.Contains(p.ClientMessageId)).ToList();
        void Waiting(PendingSupportItem p) => rows.Add(new SupportRow(SupportRowKind.Bubble, "c-" + p.ClientMessageId,
            Pending: p, Mine: true, Time: p.CreatedAt, DayHeader: Header(p.CreatedAt)));
        foreach (var p in waiting.Where(p => p.ConversationId is not null)) Waiting(p);
        var toNew = waiting.Where(p => p.ConversationId is null).ToList();
        if (conversations.Count > 0 && toNew.Count > 0)
        {
            rows.Add(new SupportRow(SupportRowKind.NewConversation, "new-next", Time: toNew[0].CreatedAt));
            if (DayOf(toNew[0].CreatedAt) is { } d) lastDay = d;
        }
        foreach (var p in toNew) Waiting(p);

        // Runs: one sender's messages in a row, unbroken by a day or a line.
        // Keys are the list's identity; a row the server sent twice is shown twice.
        var seen = new HashSet<string>();
        var result = new List<SupportRow>(rows.Count);
        for (var i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            if (!seen.Add(row.Key)) row = row with { Key = $"{row.Key}#{i}" };
            if (row.Kind == SupportRowKind.Bubble)
            {
                var previous = i > 0 && rows[i - 1].Kind == SupportRowKind.Bubble ? rows[i - 1] : null;
                var next = i + 1 < rows.Count && rows[i + 1].Kind == SupportRowKind.Bubble ? rows[i + 1] : null;
                row = row with
                {
                    StartsRun = previous is null || previous.Sender != row.Sender || row.DayHeader is not null,
                    EndsRun = next is null || next.Sender != row.Sender || next.DayHeader is not null,
                };
            }
            result.Add(row);
        }
        return result;
    }
}
