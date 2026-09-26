using Webyar.Core.Api;
using Webyar.Core.Local;

namespace Webyar.Core.Sync;

public enum ThreadSource
{
    /// <summary>From the PC, before the server was asked.</summary>
    Local,
    /// <summary>The whole thread from the server.</summary>
    Full,
    /// <summary>The PC's copy plus what changed since the last sync.</summary>
    Delta,
    /// <summary>The server confirmed the PC's copy is current (304).</summary>
    NotModified,
}

/// <summary>A thread at one moment, in display order.</summary>
public sealed record ThreadSnapshot(string WorkspaceId, string ConversationId, IReadOnlyList<Message> Messages, ThreadSource Source);

/// <summary>
/// Keeps threads in step with the server without downloading them again:
///
/// <code>
/// PC copy → shown at once
/// sync:  cursor known → GET ?since=cursor → merge the delta (upsert by id)
///        a server that reports the thread's total: the copy must add up, else ↓
///        no cursor, no delta support, or the last full read is older than
///        <see cref="ReconcileEvery"/> → full GET (If-None-Match → 304)
/// </code>
///
/// The delta protocol (server/services/messageSync.ts) has no tombstones: a
/// deleted or newly hidden message is simply not sent again. The periodic
/// full read is the authoritative reconciliation that removes it from the PC
/// (and a 403/404 removes the whole thread at once).
///
/// Syncs of one thread run one at a time, so a slow answer can never be
/// applied after a newer one, and a cursor only ever moves forward. Each
/// call is scoped by workspace and conversation; the caller decides whether
/// the result is still wanted (the operator may have moved on).
/// </summary>
public sealed class ThreadSync
{
    private const int MemoryThreads = 16;

    private readonly WebyarApi _api;
    private readonly LocalStore? _store;
    private readonly RetentionPolicy _policy;
    private readonly Action<string>? _log;
    private readonly Dictionary<(string, string), SemaphoreSlim> _gates = [];
    private readonly Dictionary<(string, string), State> _memory = [];
    private readonly LinkedList<(string, string)> _recent = new();
    private readonly object _lock = new();
    private bool _closed;

    public ThreadSync(WebyarApi api, LocalStore? store, RetentionPolicy? policy = null, Action<string>? log = null, TimeSpan? reconcileEvery = null, Func<DateTimeOffset>? clock = null)
    {
        _api = api;
        _store = store;
        _policy = policy ?? RetentionPolicy.Default;
        _log = log;
        ReconcileEvery = reconcileEvery ?? TimeSpan.FromHours(1);
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    private readonly Func<DateTimeOffset> _clock;

    /// <summary>
    /// How old a thread's last full read may be before the next sync is a full
    /// read again. Deletes are rare (retention, a Super Admin visibility switch),
    /// so an hour keeps them bounded without re-downloading open threads.
    /// </summary>
    public TimeSpan ReconcileEvery { get; }

    /// <summary>Counters for the log and the measurements.</summary>
    public ThreadSyncStats Stats { get; } = new();

    /// <summary>The PC's copy, or null when there is none.</summary>
    public async Task<ThreadSnapshot?> LoadLocalAsync(string workspaceId, string conversationId, CancellationToken ct = default)
    {
        var state = await StateAsync(workspaceId, conversationId, ct).ConfigureAwait(false);
        if (state is null) return null;
        Stats.LocalHit();
        return new ThreadSnapshot(workspaceId, conversationId, state.Messages, ThreadSource.Local);
    }

    /// <summary>
    /// Brings the thread up to date and returns it. Throws what the API
    /// throws (offline, 403…); the PC's copy is untouched by a failure,
    /// except that a thread the server says is gone or forbidden is forgotten.
    /// </summary>
    public async Task<ThreadSnapshot> SyncAsync(string workspaceId, string conversationId, CancellationToken ct = default)
    {
        var gate = Gate(workspaceId, conversationId);
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var state = await StateAsync(workspaceId, conversationId, ct).ConfigureAwait(false);
            var revalidate = state?.ETag;
            var due = state?.ReconciledAt is not { } at || _clock() - at >= ReconcileEvery;
            try
            {
                if (state?.Cursor is { } cursor && !due)
                {
                    var page = await _api.MessagesPageAsync(conversationId, cursor, null, ct).ConfigureAwait(false);
                    if (page.Value?.Sync is { IsDelta: true } sync)
                    {
                        var changes = page.Value.Messages ?? [];
                        var merged = MessageMerge.Apply(state.Messages, changes);
                        if (sync.Total is not { } total || total == merged.Count)
                        {
                            // An overlap re-sends the newest rows unchanged; only real changes invalidate the full-read tag.
                            var known = state.Messages.Where(m => m.UpdatedAt is not null).ToDictionary(m => m.Id, m => m.UpdatedAt);
                            var changed = changes.Count(c => c.UpdatedAt is null || !known.TryGetValue(c.Id, out var at) || at != c.UpdatedAt);
                            Stats.Delta(changed);
                            if (changed > 0) _log?.Invoke($"[sync] thread delta: {changed} changed");
                            var next = new State(merged, sync.Cursor ?? cursor, sync.Total, changed > 0 ? null : state.ETag, state.ReconciledAt);
                            await CommitAsync(workspaceId, conversationId, next, replace: false, changes, ct).ConfigureAwait(false);
                            return new ThreadSnapshot(workspaceId, conversationId, merged, ThreadSource.Delta);
                        }
                        // Something was deleted, hidden or missed: start from a clean snapshot.
                        Stats.Mismatch();
                        revalidate = null;
                        _log?.Invoke($"[sync] thread delta did not add up ({merged.Count} vs {sync.Total?.ToString() ?? "?"}): full reconciliation");
                    }
                    else if (page.Value is { } whole)
                    {
                        // The server answered in full (older server, too much changed).
                        return await ApplyFullAsync(workspaceId, conversationId, whole, page.ETag, ct).ConfigureAwait(false);
                    }
                }

                var full = await _api.MessagesPageAsync(conversationId, null, revalidate, ct).ConfigureAwait(false);
                if (full.NotModified && state is not null)
                {
                    Stats.Unchanged();
                    // Confirmed whole and current: this counts as a reconciliation.
                    var confirmed = state with { ReconciledAt = _clock() };
                    Remember(workspaceId, conversationId, confirmed);
                    if (_store is not null && !_closed)
                        await _store.SaveThreadAsync(workspaceId, conversationId, true, confirmed.Messages, confirmed.Cursor, confirmed.Total, confirmed.ETag, CancellationToken.None).ConfigureAwait(false);
                    return new ThreadSnapshot(workspaceId, conversationId, state.Messages, ThreadSource.NotModified);
                }
                return await ApplyFullAsync(workspaceId, conversationId, full.Value ?? new MessagesPage(), full.ETag, ct).ConfigureAwait(false);
            }
            catch (ApiException e) when (e.Failure == ApiFailure.Server && e.Status is 403 or 404)
            {
                // Deleted, or no longer this operator's: no copy of it may stay on the PC.
                await ForgetAsync(workspaceId, conversationId).ConfigureAwait(false);
                throw;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<ThreadSnapshot> ApplyFullAsync(string workspaceId, string conversationId, MessagesPage page, string? etag, CancellationToken ct)
    {
        var messages = MessageMerge.Order((page.Messages ?? []).Where(m => m.ConversationId == conversationId));
        Stats.FullFetch();
        _log?.Invoke($"[sync] thread full: {messages.Count} messages");
        var next = new State(messages, page.Sync?.Cursor, page.Sync?.Total ?? messages.Count, etag, _clock());
        await CommitAsync(workspaceId, conversationId, next, replace: true, messages, ct).ConfigureAwait(false);
        return new ThreadSnapshot(workspaceId, conversationId, messages, ThreadSource.Full);
    }

    private async Task CommitAsync(string workspaceId, string conversationId, State next, bool replace, IReadOnlyList<Message> written, CancellationToken ct)
    {
        if (_closed) return;
        Remember(workspaceId, conversationId, next);
        if (_store is null) return;
        if (next.Messages.Count > _policy.MaxMessagesPerThread)
        {
            // Too long to keep on the PC: it lives in memory for this session only.
            await _store.DeleteThreadAsync(workspaceId, conversationId, CancellationToken.None).ConfigureAwait(false);
            return;
        }
        // Not cancellable once the server's answer is in hand: a half-applied sync would be worse.
        await _store.SaveThreadAsync(workspaceId, conversationId, replace, written, next.Cursor, next.Total, next.ETag, CancellationToken.None).ConfigureAwait(false);
    }

    public async Task ForgetAsync(string workspaceId, string conversationId)
    {
        lock (_lock) _memory.Remove((workspaceId, conversationId));
        if (_store is not null) await _store.DeleteThreadAsync(workspaceId, conversationId).ConfigureAwait(false);
    }

    /// <summary>Drops the in-memory copies (Clear cache, sign-out). The store is cleared by its owner.</summary>
    public void ClearMemory()
    {
        lock (_lock)
        {
            _memory.Clear();
            _recent.Clear();
        }
    }

    /// <summary>After this nothing more is written anywhere: late answers are discarded.</summary>
    public void Close()
    {
        _closed = true;
        ClearMemory();
    }

    private async Task<State?> StateAsync(string workspaceId, string conversationId, CancellationToken ct)
    {
        lock (_lock)
        {
            if (_memory.TryGetValue((workspaceId, conversationId), out var known)) return known;
        }
        if (_store is null || _closed) return null;
        var cached = await _store.LoadThreadAsync(workspaceId, conversationId, ct).ConfigureAwait(false);
        if (cached is null) return null;
        // A copy that does not add up to its own (server-reported) total is not trusted for deltas.
        var cursor = cached.Total is null || cached.Total == cached.Messages.Count ? cached.Cursor : null;
        var state = new State(MessageMerge.Order(cached.Messages), cursor, cached.Total, cached.ETag, cached.ReconciledAt);
        Remember(workspaceId, conversationId, state);
        return state;
    }

    private void Remember(string workspaceId, string conversationId, State state)
    {
        lock (_lock)
        {
            if (_closed) return;
            var key = (workspaceId, conversationId);
            _memory[key] = state;
            _recent.Remove(key);
            _recent.AddFirst(key);
            while (_recent.Count > MemoryThreads && _recent.Last is { } last)
            {
                _recent.RemoveLast();
                _memory.Remove(last.Value);
            }
        }
    }

    private SemaphoreSlim Gate(string workspaceId, string conversationId)
    {
        lock (_lock)
        {
            if (!_gates.TryGetValue((workspaceId, conversationId), out var gate))
            {
                gate = new SemaphoreSlim(1, 1);
                _gates[(workspaceId, conversationId)] = gate;
            }
            return gate;
        }
    }

    private sealed record State(IReadOnlyList<Message> Messages, string? Cursor, int? Total, string? ETag, DateTimeOffset? ReconciledAt);
}

public sealed class ThreadSyncStats
{
    private int _localHits;
    private int _deltas;
    private int _deltaMessages;
    private int _full;
    private int _notModified;
    private int _mismatches;

    public int LocalHits => Volatile.Read(ref _localHits);
    public int Deltas => Volatile.Read(ref _deltas);
    public int DeltaMessages => Volatile.Read(ref _deltaMessages);
    public int Full => Volatile.Read(ref _full);
    public int NotModified => Volatile.Read(ref _notModified);
    public int Mismatches => Volatile.Read(ref _mismatches);

    internal void LocalHit() => Interlocked.Increment(ref _localHits);
    internal void FullFetch() => Interlocked.Increment(ref _full);
    internal void Unchanged() => Interlocked.Increment(ref _notModified);
    internal void Mismatch() => Interlocked.Increment(ref _mismatches);

    internal void Delta(int messages)
    {
        Interlocked.Increment(ref _deltas);
        Interlocked.Add(ref _deltaMessages, messages);
    }

    public override string ToString() =>
        $"local={LocalHits} delta={Deltas} deltaMessages={DeltaMessages} full={Full} notModified={NotModified} mismatches={Mismatches}";
}
