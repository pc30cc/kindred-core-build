using System.Collections.Concurrent;

namespace Webyar.Core.Caching;

/// <summary>
/// One piece of work per key at a time: five views asking for the same file
/// while it downloads share that one download instead of starting five. The
/// entry leaves as soon as the work ends — succeeded, failed or cancelled —
/// so a failure is never remembered and the next caller simply tries again.
/// </summary>
public sealed class Coalescer<TKey, TValue> where TKey : notnull
{
    private readonly ConcurrentDictionary<TKey, Task<TValue>> _running = new();
    private long _joined;

    /// <summary>How many callers were served by work another caller had already started.</summary>
    public long Joined => Interlocked.Read(ref _joined);

    public int InFlight => _running.Count;

    /// <summary>
    /// Runs <paramref name="work"/> unless the same key is already running,
    /// in which case the caller waits for that. <paramref name="ct"/> only
    /// stops this caller waiting; shared work is never cancelled by one of
    /// the callers that joined it.
    /// </summary>
    public Task<TValue> RunAsync(TKey key, Func<Task<TValue>> work, CancellationToken ct = default)
    {
        while (true)
        {
            if (_running.TryGetValue(key, out var existing))
            {
                Interlocked.Increment(ref _joined);
                return existing.WaitAsync(ct);
            }
            var source = new TaskCompletionSource<TValue>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!_running.TryAdd(key, source.Task)) continue;
            _ = RunAndReleaseAsync(key, work, source);
            return source.Task.WaitAsync(ct);
        }
    }

    private async Task RunAndReleaseAsync(TKey key, Func<Task<TValue>> work, TaskCompletionSource<TValue> source)
    {
        try
        {
            source.TrySetResult(await work().ConfigureAwait(false));
        }
        catch (OperationCanceledException e)
        {
            source.TrySetCanceled(e.CancellationToken);
        }
        catch (Exception e)
        {
            source.TrySetException(e);
        }
        finally
        {
            _running.TryRemove(new KeyValuePair<TKey, Task<TValue>>(key, source.Task));
        }
    }
}
