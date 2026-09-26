using System.Text.RegularExpressions;

namespace Webyar.Core.Caching;

public sealed record DiskCacheOptions(
    long MaxBytes,
    long TrimToBytes,
    /// <summary>Whether a read marks the file as used (LRU); off for caches that expire by age instead.</summary>
    bool TouchOnRead = true,
    /// <summary>Files older than this (by last write) count as missing; null keeps them until trimmed.</summary>
    TimeSpan? MaxAge = null,
    string Extension = ".bin");

/// <summary>
/// Files on disk by key, optionally inside a scope folder (a workspace), so
/// a download happens once and survives restarts. What it guarantees:
///
/// <list type="bullet">
/// <item>A file is either whole or absent: bytes go to a uniquely named
/// <c>.part</c> file, are flushed, then renamed into place — a crash or a
/// concurrent writer can never leave a half file under the real name, and
/// leftover <c>.part</c> files are swept on <see cref="Trim"/>.</item>
/// <item>A zero-byte or unreadable file is a miss (and is removed), never
/// an error shown to the operator.</item>
/// <item>Reads share the file for delete, so <see cref="Clear"/> or a trim
/// never fails because a view is reading, and a reader never crashes
/// because a clear ran.</item>
/// <item>A full disk turns caching off for a few minutes instead of failing
/// every write; the app keeps working from memory and the network.</item>
/// <item>"Recently used" is the file's last-write time, set explicitly on
/// read (at most hourly). NTFS last-access updates are off by default on
/// many Windows installs and are also bumped by indexers and antivirus, so
/// last-access is not trusted.</item>
/// </list>
///
/// Every method is safe to call from any thread and never throws for I/O.
/// </summary>
public sealed partial class DiskFileCache
{
    private static readonly TimeSpan TouchEvery = TimeSpan.FromHours(1);
    private static readonly TimeSpan StalePart = TimeSpan.FromHours(1);
    private static readonly TimeSpan DiskFullPause = TimeSpan.FromMinutes(5);

    private readonly DiskCacheOptions _options;
    private readonly Action<string>? _log;
    private readonly object _trimGate = new();
    private long _diskFullUntilTicks;

    public DiskFileCache(string root, DiskCacheOptions options, Action<string>? log = null)
    {
        Root = root;
        _options = options;
        _log = log;
    }

    public string Root { get; }

    /// <summary>Raised after a write or a clear, for a settings page that shows the size.</summary>
    public event EventHandler? Changed;

    /// <summary>Test hook: how bytes reach the disk. Throwing an IOException here simulates a failing disk.</summary>
    internal Action<string, byte[]> WriteFile { get; set; } = static (path, data) =>
    {
        using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.None);
        fs.Write(data, 0, data.Length);
        fs.Flush(flushToDisk: true);
    };

    [GeneratedRegex("^[A-Za-z0-9-]{1,96}$")]
    private static partial Regex KeyPattern();

    /// <summary>Keys and scopes are ids or hashes; anything else (a "local:" id) stays in memory only.</summary>
    public static bool IsValidKey(string? key) => key is not null && KeyPattern().IsMatch(key);

    public string? PathFor(string key, string? scope)
    {
        if (!IsValidKey(key) || (scope is not null && !IsValidKey(scope))) return null;
        var name = key.ToLowerInvariant() + _options.Extension;
        return scope is null ? Path.Combine(Root, name) : Path.Combine(Root, scope.ToLowerInvariant(), name);
    }

    public byte[]? Read(string key, string? scope = null)
    {
        var path = PathFor(key, scope);
        if (path is null) return null;
        var data = ReadFile(path);
        if (data is null && scope is not null)
        {
            // Files cached before workspaces had their own folders. Only an id the
            // caller is entitled to (it came from this workspace's own thread) is
            // looked up, so adopting the file into this scope exposes nothing.
            var legacy = PathFor(key, null)!;
            data = ReadFile(legacy);
            if (data is not null)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    File.Move(legacy, path, overwrite: false);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                }
            }
        }
        return data;
    }

    private byte[]? ReadFile(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists) return null;
            if (info.Length == 0 || Expired(info))
            {
                TryDelete(path);
                return null;
            }
            byte[] data;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920))
            {
                var length = fs.Length;
                if (length == 0 || length > int.MaxValue) return null;
                data = new byte[length];
                var read = 0;
                while (read < data.Length)
                {
                    var n = fs.Read(data, read, data.Length - read);
                    if (n == 0) break;
                    read += n;
                }
                if (read != data.Length) return null; // truncated underneath us
            }
            if (_options.TouchOnRead && DateTime.UtcNow - info.LastWriteTimeUtc > TouchEvery)
            {
                try
                {
                    File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                }
            }
            return data;
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log?.Invoke($"[cache] read failed: {e.GetType().Name}");
            return null;
        }
    }

    private bool Expired(FileInfo info) =>
        _options.MaxAge is { } age && DateTime.UtcNow - info.LastWriteTimeUtc > age;

    /// <summary>Stores the bytes atomically. Returns false when they were not kept (bad key, full disk, locked file).</summary>
    public bool Write(string key, string? scope, byte[] data)
    {
        var path = PathFor(key, scope);
        if (path is null || data.Length == 0) return false;
        if (DateTime.UtcNow.Ticks < Interlocked.Read(ref _diskFullUntilTicks)) return false;
        var temp = $"{path}.{Guid.NewGuid():N}.part";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            WriteFile(temp, data);
            File.Move(temp, path, overwrite: true);
            Changed?.Invoke(this, EventArgs.Empty);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            TryDelete(temp);
            if (IsDiskFull(e))
            {
                Interlocked.Exchange(ref _diskFullUntilTicks, DateTime.UtcNow.Add(DiskFullPause).Ticks);
                _log?.Invoke("[cache] disk full: caching paused");
                _ = Task.Run(Trim);
            }
            else
            {
                // Most often another writer, or a reader that does not share
                // delete, holds the final name: the file is there either way.
                _log?.Invoke($"[cache] write skipped: {e.GetType().Name}");
            }
            return false;
        }
    }

    public void Delete(string key, string? scope)
    {
        if (PathFor(key, scope) is { } path) TryDelete(path);
    }

    internal static bool IsDiskFull(Exception e) =>
        (e.HResult & 0xFFFF) is 0x70 /* ERROR_DISK_FULL */ or 0x27 /* ERROR_HANDLE_DISK_FULL */ or 28 /* ENOSPC */;

    /// <summary>Total size and file count, for the settings page.</summary>
    public (long Bytes, int Count) Measure()
    {
        long bytes = 0;
        var count = 0;
        foreach (var f in Files())
        {
            if (f.Name.EndsWith(".part", StringComparison.Ordinal)) continue;
            try
            {
                bytes += f.Length;
                count++;
            }
            catch (IOException)
            {
            }
        }
        return (bytes, count);
    }

    /// <summary>Deletes every cached file. A file some reader still holds goes as soon as it is closed.</summary>
    public void Clear()
    {
        foreach (var f in Files()) TryDelete(f.FullName);
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(Root))
            {
                try
                {
                    if (!Directory.EnumerateFileSystemEntries(dir).Any()) Directory.Delete(dir);
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                }
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        Interlocked.Exchange(ref _diskFullUntilTicks, 0);
        Changed?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>
    /// Sweeps leftovers (stale .part files, empty or expired files), then drops
    /// the least recently used files once the cache outgrows its limit.
    /// </summary>
    public int Trim()
    {
        if (!Monitor.TryEnter(_trimGate)) return 0;
        try
        {
            var now = DateTime.UtcNow;
            var kept = new List<FileInfo>();
            var removed = 0;
            foreach (var f in Files())
            {
                try
                {
                    var stale = f.Name.EndsWith(".part", StringComparison.Ordinal)
                        ? now - f.LastWriteTimeUtc > StalePart
                        : f.Length == 0 || Expired(f);
                    if (stale)
                    {
                        if (TryDelete(f.FullName)) removed++;
                    }
                    else if (!f.Name.EndsWith(".part", StringComparison.Ordinal))
                    {
                        kept.Add(f);
                    }
                }
                catch (IOException)
                {
                }
            }
            var total = kept.Sum(f => f.Length);
            if (total > _options.MaxBytes)
            {
                foreach (var f in kept.OrderBy(f => f.LastWriteTimeUtc))
                {
                    if (total <= _options.TrimToBytes) break;
                    var length = f.Length;
                    if (TryDelete(f.FullName))
                    {
                        total -= length;
                        removed++;
                    }
                }
            }
            if (removed > 0) _log?.Invoke($"[cache] trimmed {removed} files, {total / 1024} KB kept");
            return removed;
        }
        finally
        {
            Monitor.Exit(_trimGate);
        }
    }

    private IEnumerable<FileInfo> Files()
    {
        try
        {
            if (!Directory.Exists(Root)) return [];
            return new DirectoryInfo(Root).EnumerateFiles("*", SearchOption.AllDirectories).ToList();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static bool TryDelete(string path)
    {
        try
        {
            File.Delete(path);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
