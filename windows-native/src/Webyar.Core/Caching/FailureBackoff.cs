using System.Collections.Concurrent;

namespace Webyar.Core.Caching;

/// <summary>
/// Remembers what just failed (an avatar URL that 404s, a host that is down)
/// so it is not asked for again on every redraw — but only for a while: each
/// further failure doubles the pause up to <see cref="Max"/>, and a success
/// forgets it. A broken URL is retried later, never given up on for good.
/// </summary>
public sealed class FailureBackoff<TKey> where TKey : notnull
{
    private readonly ConcurrentDictionary<TKey, (int Failures, DateTimeOffset RetryAt)> _failed = new();

    public FailureBackoff(TimeSpan first, TimeSpan max)
    {
        First = first;
        Max = max;
    }

    public TimeSpan First { get; }
    public TimeSpan Max { get; }

    public bool ShouldTry(TKey key, DateTimeOffset now) =>
        !_failed.TryGetValue(key, out var f) || now >= f.RetryAt;

    public void Failed(TKey key, DateTimeOffset now) =>
        _failed.AddOrUpdate(key,
            _ => (1, now + First),
            (_, f) =>
            {
                var failures = f.Failures + 1;
                var wait = TimeSpan.FromTicks(Math.Min(Max.Ticks, First.Ticks * (1L << Math.Min(failures - 1, 20))));
                return (failures, now + wait);
            });

    public void Succeeded(TKey key) => _failed.TryRemove(key, out _);

    public void Clear() => _failed.Clear();
}
