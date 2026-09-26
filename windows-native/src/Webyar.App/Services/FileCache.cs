using Webyar.Core.Caching;

namespace Webyar.App.Services;

/// <summary>
/// Message files on disk, keyed by attachment id inside a folder per
/// workspace, so a photo, voice note or document is downloaded once and
/// opened from the PC after that — across conversations and restarts. The
/// least recently used files go first once the cache outgrows 1 GB (down to
/// 800 MB). The rules — atomic writes, leftovers swept, full disk, locked
/// files, zero-byte files — live in <see cref="DiskFileCache"/>.
/// </summary>
public static class FileCache
{
    private const long MaxBytes = 1024L * 1024 * 1024;
    private const long TrimTo = 800L * 1024 * 1024;

    private static readonly DiskFileCache Disk = new(AppPaths.Files, new DiskCacheOptions(MaxBytes, TrimTo), Log.Write);

    public static string Folder => AppPaths.Files;

    public static event EventHandler? Changed
    {
        add => Disk.Changed += value;
        remove => Disk.Changed -= value;
    }

    /// <param name="workspaceId">The workspace the file was seen in; null only for files with no workspace.</param>
    public static byte[]? Read(string id, string? workspaceId) => Disk.Read(id, Scope(workspaceId));

    public static void Write(string id, string? workspaceId, byte[] data)
    {
        if (Disk.Write(id, Scope(workspaceId), data)) Log.Write($"[files] stored {data.Length / 1024} KB");
    }

    /// <summary>Total size and file count, for the settings page.</summary>
    public static (long Bytes, int Count) Measure() => Disk.Measure();

    public static void Clear() => Disk.Clear();

    /// <summary>Sweeps leftovers and drops the least recently used files once the cache is over its limit.</summary>
    public static void Trim() => Disk.Trim();

    private static string? Scope(string? workspaceId) => DiskFileCache.IsValidKey(workspaceId) ? workspaceId : null;
}
