using Webyar.Core.Api;

namespace Webyar.Core.Sync;

/// <summary>
/// How a thread copy absorbs what the server sends. Pure, so every rule is
/// tested without a server, a database or a window:
/// <list type="bullet">
/// <item>one message per id — the same message from realtime, a delta and a
/// full fetch is still one message;</item>
/// <item>a copy never goes back in time: an incoming version older than the
/// stored one (by updated_at) is ignored;</item>
/// <item>order is creation time, then id, so the order never depends on
/// which answer arrived first.</item>
/// </list>
/// </summary>
public static class MessageMerge
{
    public static List<Message> Apply(IEnumerable<Message> local, IEnumerable<Message> changes)
    {
        var byId = new Dictionary<string, Message>();
        foreach (var m in local) byId[m.Id] = m;
        foreach (var m in changes)
        {
            if (!byId.TryGetValue(m.Id, out var existing) || !IsOlder(m, existing)) byId[m.Id] = m;
        }
        return Order(byId.Values);
    }

    /// <summary>True when <paramref name="incoming"/> is a strictly older version of <paramref name="existing"/>.</summary>
    public static bool IsOlder(Message incoming, Message existing) =>
        incoming.UpdatedAt is { } i && existing.UpdatedAt is { } e && i < e;

    public static List<Message> Order(IEnumerable<Message> messages) =>
        messages
            .OrderBy(m => m.CreatedAt ?? DateTimeOffset.MinValue)
            .ThenBy(m => m.Id, StringComparer.Ordinal)
            .ToList();
}

/// <summary>
/// Optimistic bubbles for replies on their way. A bubble leaves as soon as
/// the server's own copy of that reply is in the thread — matched by the
/// client_message_id the composer sent — however that copy arrived
/// (the send's answer, a realtime event, a delta or a full fetch), and not
/// a moment before, so the reply is never shown twice and never blinks out.
/// </summary>
public static class Outbox
{
    public static List<T> StillPending<T>(IEnumerable<T> outbox, Func<T, string?> clientId, IEnumerable<Message> thread)
    {
        var confirmed = thread.Select(m => m.ClientMessageId).Where(id => id is not null).ToHashSet(StringComparer.Ordinal);
        return outbox.Where(o => clientId(o) is not { } id || !confirmed.Contains(id)).ToList();
    }
}

/// <summary>What the chat does with a file when a message is drawn.</summary>
public static class AttachmentPolicy
{
    /// <summary>
    /// Only photos are fetched as the thread renders (for their preview).
    /// Voice notes wait for Play, and documents and videos for Open or Save:
    /// scrolling a thread never downloads them.
    /// </summary>
    public static bool FetchOnRender(string kind) => kind == "image";
}
