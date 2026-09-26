using Webyar.Core.Caching;
using Xunit;

namespace Webyar.Core.Tests;

public class DiskFileCacheTests
{
    private static readonly string Id1 = "0b7c52a4-6d2e-4f53-9a3f-1f2d3c4b5a61";
    private static readonly string Id2 = "1c8d63b5-7e3f-4064-8b4a-2e3f4d5c6b72";
    private const string Ws = "6ee40d07-0000-4000-8000-000000000001";

    private static DiskFileCache Cache(TempDir dir, long max = 1000, long trimTo = 800, TimeSpan? maxAge = null, bool touch = true) =>
        new(dir.Path, new DiskCacheOptions(max, trimTo, touch, maxAge));

    [Fact]
    public void Writes_are_atomic_and_read_back()
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        Assert.True(cache.Write(Id1, Ws, [1, 2, 3]));
        Assert.Equal([1, 2, 3], cache.Read(Id1, Ws));
        Assert.Empty(Directory.GetFiles(dir.Path, "*.part", SearchOption.AllDirectories));
        // Scoped by workspace on disk.
        Assert.True(File.Exists(Path.Combine(dir.Path, Ws, Id1 + ".bin")));
    }

    [Fact]
    public void A_crash_mid_write_leaves_no_half_file_and_the_leftover_is_swept()
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        cache.WriteFile = (path, data) =>
        {
            File.WriteAllBytes(path, data[..1]); // half written …
            throw new IOException("process killed"); // … then gone
        };
        Assert.False(cache.Write(Id1, Ws, [1, 2, 3]));
        Assert.Null(cache.Read(Id1, Ws));
        // A .part left by a real crash (older than an hour) goes on the next trim.
        var stale = Path.Combine(dir.Path, Ws, Id2 + ".bin.abc.part");
        Directory.CreateDirectory(Path.GetDirectoryName(stale)!);
        File.WriteAllBytes(stale, [9]);
        File.SetLastWriteTimeUtc(stale, DateTime.UtcNow.AddHours(-2));
        cache.Trim();
        Assert.False(File.Exists(stale));
    }

    [Fact]
    public void A_zero_byte_file_is_a_miss_and_is_removed()
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        var path = cache.PathFor(Id1, Ws)!;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, []);
        Assert.Null(cache.Read(Id1, Ws));
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void A_full_disk_pauses_caching_instead_of_failing()
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        var writes = 0;
        cache.WriteFile = (_, _) =>
        {
            writes++;
            throw new IOException("There is not enough space on the disk.", unchecked((int)0x80070070));
        };
        Assert.False(cache.Write(Id1, Ws, [1]));
        Assert.False(cache.Write(Id2, Ws, [1])); // paused: not even attempted
        Assert.Equal(1, writes);
        Assert.Empty(Directory.GetFiles(dir.Path, "*", SearchOption.AllDirectories));
        cache.Clear(); // freeing space resumes caching
        cache.WriteFile = (path, data) => File.WriteAllBytes(path, data);
        Assert.True(cache.Write(Id2, Ws, [1]));
    }

    [Fact]
    public async Task Concurrent_reads_and_writes_of_one_file_never_see_a_torn_file()
    {
        using var dir = new TempDir();
        var cache = Cache(dir, max: 10_000_000, trimTo: 8_000_000);
        var payload = Enumerable.Range(0, 64 * 1024).Select(i => (byte)(i % 251)).ToArray();
        var tasks = new List<Task>();
        for (var i = 0; i < 8; i++)
        {
            tasks.Add(Task.Run(() => cache.Write(Id1, Ws, payload)));
            tasks.Add(Task.Run(() =>
            {
                var read = cache.Read(Id1, Ws);
                if (read is not null) Assert.Equal(payload, read); // whole or nothing
            }));
        }
        await Task.WhenAll(tasks);
        Assert.Equal(payload, cache.Read(Id1, Ws));
        Assert.Empty(Directory.GetFiles(dir.Path, "*.part", SearchOption.AllDirectories));
    }

    [Fact]
    public void Clearing_while_a_file_is_open_for_reading_neither_fails_nor_breaks_the_reader()
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        cache.Write(Id1, Ws, [1, 2, 3, 4]);
        using (var reader = new FileStream(cache.PathFor(Id1, Ws)!, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            cache.Clear();
            var buffer = new byte[4];
            Assert.Equal(4, reader.Read(buffer));
        }
        Assert.Null(cache.Read(Id1, Ws));
        Assert.Equal((0L, 0), cache.Measure());
    }

    [Fact]
    public void Trim_drops_the_least_recently_used_files_first()
    {
        using var dir = new TempDir();
        var cache = Cache(dir, max: 250, trimTo: 200);
        var ids = Enumerable.Range(0, 3).Select(i => Guid.NewGuid().ToString()).ToArray();
        for (var i = 0; i < 3; i++)
        {
            cache.Write(ids[i], Ws, new byte[100]);
            File.SetLastWriteTimeUtc(cache.PathFor(ids[i], Ws)!, DateTime.UtcNow.AddHours(-10 + i));
        }
        cache.Read(ids[0], Ws); // used just now (the touch is explicit, not NTFS last-access)
        cache.Trim();
        Assert.NotNull(cache.Read(ids[0], Ws));
        Assert.Null(cache.Read(ids[1], Ws)); // oldest unused
        Assert.NotNull(cache.Read(ids[2], Ws));
    }

    [Fact]
    public void Files_cached_before_workspace_folders_are_adopted_not_downloaded_again()
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        File.WriteAllBytes(Path.Combine(dir.Path, Id1 + ".bin"), [7, 7]); // the old flat layout
        Assert.Equal([7, 7], cache.Read(Id1, Ws));
        Assert.True(File.Exists(cache.PathFor(Id1, Ws)));
        Assert.False(File.Exists(Path.Combine(dir.Path, Id1 + ".bin")));
    }

    [Fact]
    public void Another_workspace_does_not_see_a_scoped_file()
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        cache.Write(Id1, Ws, [1]);
        Assert.Null(cache.Read(Id1, "7ee40d07-0000-4000-8000-000000000002"));
    }

    [Theory]
    [InlineData("local:1234")]
    [InlineData("../../etc/passwd")]
    [InlineData("")]
    public void Keys_that_are_not_ids_never_touch_the_disk(string key)
    {
        using var dir = new TempDir();
        var cache = Cache(dir);
        Assert.False(cache.Write(key, Ws, [1]));
        Assert.Null(cache.Read(key, Ws));
        Assert.Null(cache.PathFor(Id1, "../x"));
    }

    [Fact]
    public void Expired_entries_count_as_missing()
    {
        using var dir = new TempDir();
        var cache = Cache(dir, maxAge: TimeSpan.FromDays(7), touch: false);
        cache.Write("abc123", null, [1]);
        Assert.NotNull(cache.Read("abc123"));
        File.SetLastWriteTimeUtc(cache.PathFor("abc123", null)!, DateTime.UtcNow.AddDays(-8));
        Assert.Null(cache.Read("abc123"));
    }
}
