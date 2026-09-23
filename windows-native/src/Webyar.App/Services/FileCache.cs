namespace Webyar.App.Services;

/// <summary>
/// Message files on disk, keyed by attachment id, so a photo, voice note or
/// document is downloaded once and opened from the PC after that — across
/// conversations and restarts. The oldest files go first once the cache
/// outgrows <see cref="MaxBytes"/>.
/// </summary>
public static class FileCache
{
    private const long MaxBytes = 1024L * 1024 * 1024;
    private const long TrimTo = 800L * 1024 * 1024;

    public static string Folder => AppPaths.Files;

    public static event EventHandler? Changed;

    public static byte[]? Read(string id)
    {
        if (!Valid(id)) return null;
        var path = PathFor(id);
        try
        {
            if (!File.Exists(path)) return null;
            File.SetLastAccessTimeUtc(path, DateTime.UtcNow);
            return File.ReadAllBytes(path);
        }
        catch (Exception e)
        {
            Log.Error("file cache read", e);
            return null;
        }
    }

    public static void Write(string id, byte[] data)
    {
        if (!Valid(id) || data.Length == 0) return;
        try
        {
            var path = PathFor(id);
            var temp = path + ".part";
            File.WriteAllBytes(temp, data);
            File.Move(temp, path, overwrite: true);
            Changed?.Invoke(null, EventArgs.Empty);
        }
        catch (Exception e)
        {
            Log.Error("file cache write", e);
        }
    }

    /// <summary>Total size and file count, for the settings page.</summary>
    public static (long Bytes, int Count) Measure()
    {
        try
        {
            var files = new DirectoryInfo(Folder).GetFiles();
            return (files.Sum(f => f.Length), files.Length);
        }
        catch
        {
            return (0, 0);
        }
    }

    public static void Clear()
    {
        foreach (var file in SafeFiles())
        {
            try { file.Delete(); }
            catch (IOException) { /* in use by an open viewer; it goes next time */ }
            catch (UnauthorizedAccessException) { }
        }
        Changed?.Invoke(null, EventArgs.Empty);
    }

    /// <summary>Drops the least recently used files once the cache is over its limit.</summary>
    public static void Trim()
    {
        var files = SafeFiles();
        var total = files.Sum(f => f.Length);
        if (total <= MaxBytes) return;
        foreach (var file in files.OrderBy(f => f.LastAccessTimeUtc))
        {
            if (total <= TrimTo) break;
            try
            {
                var length = file.Length;
                file.Delete();
                total -= length;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static FileInfo[] SafeFiles()
    {
        try { return new DirectoryInfo(Folder).GetFiles(); }
        catch { return []; }
    }

    // Ids are server UUIDs; anything else (a local "local:…" id) stays in memory only.
    private static bool Valid(string id) => Guid.TryParse(id, out _);

    private static string PathFor(string id) => Path.Combine(Folder, id.ToLowerInvariant() + ".bin");
}
