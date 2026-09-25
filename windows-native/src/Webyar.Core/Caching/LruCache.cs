namespace Webyar.Core.Caching;

/// <summary>
/// A small in-memory cache bounded by what its entries cost — bytes for a
/// file, decoded pixels for a picture — not by how many there are, so one
/// 20 MB video cannot sit in RAM as cheaply as a 20 KB photo. The least
/// recently used entries go first; an entry dearer than
/// <see cref="MaxItemCost"/> is never kept at all. Thread-safe.
/// </summary>
public sealed class LruCache<TKey, TValue> where TKey : notnull
{
    private readonly object _gate = new();
    private readonly Dictionary<TKey, LinkedListNode<Entry>> _map = [];
    private readonly LinkedList<Entry> _order = new();
    private long _cost;

    public LruCache(long maxCost, long maxItemCost)
    {
        if (maxCost <= 0) throw new ArgumentOutOfRangeException(nameof(maxCost));
        MaxCost = maxCost;
        MaxItemCost = Math.Min(maxItemCost, maxCost);
    }

    public long MaxCost { get; }
    public long MaxItemCost { get; }

    /// <summary>Raised (outside the lock) with the key of every entry pushed out to make room.</summary>
    public event Action<TKey>? Evicted;

    public long Cost
    {
        get { lock (_gate) return _cost; }
    }

    public int Count
    {
        get { lock (_gate) return _map.Count; }
    }

    public bool TryGet(TKey key, out TValue value)
    {
        lock (_gate)
        {
            if (_map.TryGetValue(key, out var node))
            {
                _order.Remove(node);
                _order.AddFirst(node);
                value = node.Value.Value;
                return true;
            }
        }
        value = default!;
        return false;
    }

    /// <summary>Stores or replaces an entry. Returns false when it is too dear to keep.</summary>
    public bool Set(TKey key, TValue value, long cost)
    {
        if (cost < 0) cost = 0;
        List<TKey>? evicted = null;
        lock (_gate)
        {
            if (_map.TryGetValue(key, out var existing))
            {
                _order.Remove(existing);
                _map.Remove(key);
                _cost -= existing.Value.Cost;
            }
            if (cost > MaxItemCost) return false;
            var node = _order.AddFirst(new Entry(key, value, cost));
            _map[key] = node;
            _cost += cost;
            while (_cost > MaxCost && _order.Last is { } last && last != node)
            {
                _order.RemoveLast();
                _map.Remove(last.Value.Key);
                _cost -= last.Value.Cost;
                (evicted ??= []).Add(last.Value.Key);
            }
        }
        if (evicted is not null)
        {
            foreach (var k in evicted) Evicted?.Invoke(k);
        }
        return true;
    }

    public bool Remove(TKey key)
    {
        lock (_gate)
        {
            if (!_map.Remove(key, out var node)) return false;
            _order.Remove(node);
            _cost -= node.Value.Cost;
            return true;
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _map.Clear();
            _order.Clear();
            _cost = 0;
        }
    }

    /// <summary>Drops least recently used entries until the total is at most <paramref name="targetCost"/> (memory pressure).</summary>
    public void TrimTo(long targetCost)
    {
        lock (_gate)
        {
            while (_cost > targetCost && _order.Last is { } last)
            {
                _order.RemoveLast();
                _map.Remove(last.Value.Key);
                _cost -= last.Value.Cost;
            }
        }
    }

    private sealed record Entry(TKey Key, TValue Value, long Cost);
}
