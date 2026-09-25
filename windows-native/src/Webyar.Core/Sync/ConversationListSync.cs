using Webyar.Core.Api;
using Webyar.Core.Caching;
using Webyar.Core.Local;

namespace Webyar.Core.Sync;

public sealed record ListResult(string WorkspaceId, InboxFilter Filter, IReadOnlyList<Conversation> Conversations, bool NotModified, string? ETag);

/// <summary>
/// The inbox queues, kept on the PC and revalidated instead of re-downloaded.
///
/// A queue is cached as the server's whole answer plus its ETag, never merged
/// row by row: unread counts, "needs reply", who handled a resolved thread
/// and whether a row belongs in the queue at all are worked out by the
/// server per request, so the only safe unit is its complete answer. An
/// unchanged queue costs a 304 and no body; a changed one replaces the copy
/// (rows that left the queue leave the copy with it).
///
/// Two callers asking for the same queue at the same time — the inbox and
/// the background notifier both watch Open — share one request.
/// </summary>
public sealed class ConversationListSync
{
    private readonly WebyarApi _api;
    private readonly LocalStore? _store;
    private readonly Action<string>? _log;
    private readonly Coalescer<(string, InboxFilter), ListResult> _inflight = new();
    private readonly Dictionary<(string, InboxFilter), (IReadOnlyList<Conversation> List, string? ETag)> _memory = [];
    private readonly object _lock = new();
    private bool _closed;

    public ConversationListSync(WebyarApi api, LocalStore? store, Action<string>? log = null)
    {
        _api = api;
        _store = store;
        _log = log;
    }

    public int Fetches { get; private set; }
    public int NotModified { get; private set; }

    /// <summary>How many callers were answered by a request someone else had already made.</summary>
    public long Coalesced => _inflight.Joined;

    public static string KeyOf(InboxFilter filter) => filter.ToString();

    /// <summary>The PC's copy of a queue, or null when there is none.</summary>
    public async Task<IReadOnlyList<Conversation>?> LoadLocalAsync(string workspaceId, InboxFilter filter, CancellationToken ct = default)
    {
        var known = await KnownAsync(workspaceId, filter, ct).ConfigureAwait(false);
        return known?.List;
    }

    /// <summary>The queue from the server (or "unchanged" with the PC's copy). Throws what the API throws.</summary>
    public Task<ListResult> FetchAsync(string workspaceId, InboxFilter filter, CancellationToken ct = default) =>
        // Shared work runs to completion even if the caller that started it
        // goes away; each caller only stops waiting.
        _inflight.RunAsync((workspaceId, filter), () => FetchOnceAsync(workspaceId, filter), ct);

    private async Task<ListResult> FetchOnceAsync(string workspaceId, InboxFilter filter)
    {
        var known = await KnownAsync(workspaceId, filter, CancellationToken.None).ConfigureAwait(false);
        var r = await _api.ConversationsConditionalAsync(workspaceId, filter, known?.ETag, CancellationToken.None).ConfigureAwait(false);
        lock (_lock) Fetches++;
        if (r.NotModified && known is { } k)
        {
            lock (_lock) NotModified++;
            return new ListResult(workspaceId, filter, k.List, true, k.ETag);
        }
        // Defensive: a row of another workspace never enters this one's copy.
        var list = (r.Value ?? []).Where(c => c.WorkspaceId == workspaceId).ToList();
        if (_closed) return new ListResult(workspaceId, filter, list, false, r.ETag);
        lock (_lock) _memory[(workspaceId, filter)] = (list, r.ETag);
        _log?.Invoke($"[sync] list {KeyOf(filter)}: {list.Count} conversations ({r.Bytes / 1024} KB)");
        if (_store is not null) await _store.SaveListAsync(workspaceId, KeyOf(filter), list, r.ETag, CancellationToken.None).ConfigureAwait(false);
        return new ListResult(workspaceId, filter, list, false, r.ETag);
    }

    /// <summary>
    /// Stores the queue as the inbox shows it (with each visitor's OS and
    /// country), so the next launch draws it complete. Only if the copy is
    /// still the answer tagged <paramref name="etag"/>: a newer answer that
    /// arrived meanwhile is never overwritten by an older one.
    /// </summary>
    public async Task SaveShownAsync(string workspaceId, InboxFilter filter, IReadOnlyList<Conversation> shown, string? etag)
    {
        if (_closed) return;
        lock (_lock)
        {
            if (!_memory.TryGetValue((workspaceId, filter), out var current) || current.ETag != etag) return;
            _memory[(workspaceId, filter)] = (shown, etag);
        }
        if (_store is not null) await _store.SaveListAsync(workspaceId, KeyOf(filter), shown, etag).ConfigureAwait(false);
    }

    /// <summary>A conversation the PC knows from any queue, for a thread opened from a notification.</summary>
    public async Task<Conversation?> FindLocalAsync(string workspaceId, string conversationId, CancellationToken ct = default)
    {
        lock (_lock)
        {
            foreach (var ((ws, _), entry) in _memory)
            {
                if (ws == workspaceId && entry.List.FirstOrDefault(c => c.Id == conversationId) is { } hit) return hit;
            }
        }
        return _store is null ? null : await _store.LoadConversationAsync(workspaceId, conversationId, ct).ConfigureAwait(false);
    }

    public void ClearMemory()
    {
        lock (_lock) _memory.Clear();
    }

    /// <summary>After this nothing more is remembered or written: late answers are discarded.</summary>
    public void Close()
    {
        _closed = true;
        ClearMemory();
    }

    private async Task<(IReadOnlyList<Conversation> List, string? ETag)?> KnownAsync(string workspaceId, InboxFilter filter, CancellationToken ct)
    {
        lock (_lock)
        {
            if (_memory.TryGetValue((workspaceId, filter), out var known)) return known;
        }
        if (_store is null || _closed) return null;
        var cached = await _store.LoadListAsync(workspaceId, KeyOf(filter), ct).ConfigureAwait(false);
        if (cached is null) return null;
        var entry = (cached.Conversations, cached.ETag);
        lock (_lock)
        {
            if (_closed) return null;
            // A fetch may have landed while the file was read; it is newer.
            if (_memory.TryGetValue((workspaceId, filter), out var fresher)) return fresher;
            _memory[(workspaceId, filter)] = entry;
        }
        return entry;
    }
}
