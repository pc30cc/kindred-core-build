using System.Collections.Concurrent;
using Webyar.Core.Caching;

namespace Webyar.App.Services;

/// <summary>
/// Where a message file's bytes come from: memory, then the PC
/// (<see cref="FileCache"/>), then the server — and back into both.
///
/// Memory is a small window over the disk cache, not a copy of it: 32 MB
/// in total, counted in bytes, and nothing over 8 MB is kept in RAM at all
/// (a big video or document is read from disk each time it is opened, which
/// is rare, instead of sitting in memory for the rest of the session).
/// Photos in a thread and voice notes — the files that are opened again and
/// again — fit comfortably. Views that ask for the same file together share
/// one read or download.
/// </summary>
public static class AttachmentStore
{
    private const long MemoryBytes = 32L * 1024 * 1024;
    private const long MemoryItemBytes = 8L * 1024 * 1024;

    private static readonly LruCache<string, byte[]> Memory = new(MemoryBytes, MemoryItemBytes);
    private static readonly Coalescer<string, byte[]> Loads = new();

    /// <summary>Files the operator picked and is sending: kept until the send has an id, or is abandoned.</summary>
    private static readonly ConcurrentDictionary<string, byte[]> Outgoing = new();

    /// <summary>Bumped by every clear, so a download that finishes afterwards does not refill the memory.</summary>
    private static int _generation;

    private static long _memoryHits;
    private static long _diskHits;
    private static long _downloads;

    public static bool IsLocal(string id) => id.StartsWith("local:", StringComparison.Ordinal);

    public static void AddOutgoing(string localId, byte[] data) => Outgoing[localId] = data;

    public static async Task<byte[]> GetAsync(string id, string? workspaceId, CancellationToken ct = default)
    {
        if (Outgoing.TryGetValue(id, out var outgoing)) return outgoing;
        if (Memory.TryGet(id, out var cached))
        {
            Interlocked.Increment(ref _memoryHits);
            return cached;
        }
        if (IsLocal(id)) throw new InvalidOperationException("A file that was never sent has no copy anywhere else.");
        return await Loads.RunAsync(id, () => LoadAsync(id, workspaceId), ct);
    }

    private static async Task<byte[]> LoadAsync(string id, string? workspaceId)
    {
        var generation = Volatile.Read(ref _generation);
        var data = await Task.Run(() => FileCache.Read(id, workspaceId)).ConfigureAwait(false);
        if (data is not null)
        {
            Interlocked.Increment(ref _diskHits);
        }
        else
        {
            data = await AppHost.Current.Api.AttachmentDataAsync(id).ConfigureAwait(false);
            Interlocked.Increment(ref _downloads);
            Log.Write($"[files] downloaded {data.Length / 1024} KB");
            var bytes = data;
            _ = Task.Run(() => FileCache.Write(id, workspaceId, bytes));
        }
        if (Volatile.Read(ref _generation) == generation) Memory.Set(id, data, data.LongLength);
        return data;
    }

    /// <summary>
    /// A file the operator just sent now has its server id: the bytes carry
    /// over (memory and disk), so the confirmed message does not download
    /// what was just uploaded.
    /// </summary>
    public static void Alias(string localId, string serverId, string? workspaceId)
    {
        if (!Outgoing.TryRemove(localId, out var data)) return;
        Memory.Set(serverId, data, data.LongLength);
        _ = Task.Run(() => FileCache.Write(serverId, workspaceId, data));
    }

    /// <summary>An outgoing file that will not be sent after all (the thread was closed).</summary>
    public static void Forget(string localId) => Outgoing.TryRemove(localId, out _);

    /// <summary>After Clear cache: memory goes too. Files being sent are kept, their send still needs them.</summary>
    public static void ClearMemory()
    {
        Interlocked.Increment(ref _generation);
        Memory.Clear();
    }

    /// <summary>Sign-out: nothing of the last operator's files stays in memory.</summary>
    public static void ClearAll()
    {
        ClearMemory();
        Outgoing.Clear();
    }

    public static string Stats() =>
        $"memory={Memory.Cost / 1024}KB/{Memory.Count} hits={Interlocked.Read(ref _memoryHits)} disk={Interlocked.Read(ref _diskHits)} downloads={Interlocked.Read(ref _downloads)} coalesced={Loads.Joined}";
}
