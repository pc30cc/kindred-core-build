using Webyar.Core.Caching;
using Xunit;

namespace Webyar.Core.Tests;

public class CachingTests
{
    [Fact]
    public void Memory_cache_is_bounded_by_bytes_not_by_entries()
    {
        var evicted = new List<string>();
        var cache = new LruCache<string, byte[]>(maxCost: 100, maxItemCost: 60);
        cache.Evicted += evicted.Add;
        cache.Set("a", new byte[40], 40);
        cache.Set("b", new byte[40], 40);
        Assert.True(cache.TryGet("a", out _)); // a is now the most recent
        cache.Set("c", new byte[40], 40); // 120 > 100: b (least recent) goes
        Assert.Equal(["b"], evicted);
        Assert.False(cache.TryGet("b", out _));
        Assert.Equal(80, cache.Cost);

        // A 20 MB video is never held in RAM like a 20 KB photo.
        Assert.False(cache.Set("big", new byte[70], 70));
        Assert.False(cache.TryGet("big", out _));
        Assert.Equal(80, cache.Cost);

        cache.TrimTo(40);
        Assert.Equal(1, cache.Count);
        cache.Clear();
        Assert.Equal(0, cache.Cost);
    }

    [Fact]
    public void Replacing_an_entry_does_not_count_it_twice()
    {
        var cache = new LruCache<string, int>(100, 100);
        cache.Set("a", 1, 50);
        cache.Set("a", 2, 30);
        Assert.Equal(30, cache.Cost);
        Assert.True(cache.TryGet("a", out var v));
        Assert.Equal(2, v);
    }

    [Fact]
    public async Task Five_views_asking_for_one_file_make_one_download()
    {
        var coalescer = new Coalescer<string, byte[]>();
        var downloads = 0;
        var gate = new TaskCompletionSource();
        async Task<byte[]> Download()
        {
            Interlocked.Increment(ref downloads);
            await gate.Task;
            return [1, 2, 3];
        }
        var views = Enumerable.Range(0, 5).Select(_ => coalescer.RunAsync("file-1", Download)).ToList();
        gate.SetResult();
        var results = await Task.WhenAll(views);
        Assert.Equal(1, downloads);
        Assert.Equal(4, coalescer.Joined);
        Assert.All(results, r => Assert.Equal(3, r.Length));
        Assert.Equal(0, coalescer.InFlight);
    }

    [Fact]
    public async Task A_failed_download_is_not_remembered_and_the_next_try_runs()
    {
        var coalescer = new Coalescer<string, int>();
        var attempts = 0;
        await Assert.ThrowsAsync<HttpRequestException>(() => coalescer.RunAsync("x", async () =>
        {
            attempts++;
            await Task.Yield();
            throw new HttpRequestException("offline");
        }));
        Assert.Equal(0, coalescer.InFlight);
        Assert.Equal(7, await coalescer.RunAsync("x", () => { attempts++; return Task.FromResult(7); }));
        Assert.Equal(2, attempts);
    }

    [Fact]
    public async Task One_caller_giving_up_does_not_cancel_the_shared_download()
    {
        var coalescer = new Coalescer<string, int>();
        var gate = new TaskCompletionSource();
        using var cts = new CancellationTokenSource();
        var patient = coalescer.RunAsync("x", async () => { await gate.Task; return 1; });
        var impatient = coalescer.RunAsync("x", () => Task.FromResult(2), cts.Token);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => impatient);
        gate.SetResult();
        Assert.Equal(1, await patient);
    }

    [Fact]
    public void A_broken_url_is_retried_later_not_never()
    {
        var backoff = new FailureBackoff<string>(TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(10));
        var t = DateTimeOffset.UnixEpoch;
        Assert.True(backoff.ShouldTry("u", t));
        backoff.Failed("u", t);
        Assert.False(backoff.ShouldTry("u", t.AddSeconds(30)));
        Assert.True(backoff.ShouldTry("u", t.AddMinutes(1)));
        backoff.Failed("u", t.AddMinutes(1)); // second failure: two minutes
        Assert.False(backoff.ShouldTry("u", t.AddMinutes(2)));
        Assert.True(backoff.ShouldTry("u", t.AddMinutes(3)));
        for (var i = 0; i < 10; i++) backoff.Failed("u", t);
        Assert.True(backoff.ShouldTry("u", t.AddMinutes(10))); // capped
        backoff.Succeeded("u");
        Assert.True(backoff.ShouldTry("u", t));
    }
}
