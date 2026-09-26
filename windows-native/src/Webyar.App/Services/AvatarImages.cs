using System.Runtime.InteropServices.WindowsRuntime;
using System.Security.Cryptography;
using System.Text;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.Core.Caching;

namespace Webyar.App.Services;

/// <summary>
/// Profile photos for <see cref="Controls.Avatar"/>: decoded pictures in a
/// small memory cache, the downloaded bytes on disk, the network last.
///
/// Why not just <c>new BitmapImage(url)</c>: WinUI keeps no image the app
/// can rely on across a list refresh, a recycled row or a restart, so every
/// realised row went back to the network — and offline the inbox lost every
/// photo. Avatar URLs are public and unsigned (the server derives them from
/// the storage key), so the URL itself is a stable cache key; a new photo or
/// a moved storage provider means a new URL and a fresh download. Files
/// still expire after a week, for a URL whose content was replaced in place.
///
/// Kept apart from message files (<see cref="FileCache"/>): different
/// owner (public images, not a workspace's private files), size and lifetime.
/// A URL that fails is not asked for again at every redraw, but is retried
/// after a pause that grows up to half an hour.
/// </summary>
public static class AvatarImages
{
    private const long MaxDownload = 2 * 1024 * 1024;

    private static readonly DiskFileCache Disk = new(AppPaths.Avatars,
        new DiskCacheOptions(MaxBytes: 64L * 1024 * 1024, TrimToBytes: 48L * 1024 * 1024, TouchOnRead: false, MaxAge: TimeSpan.FromDays(7), Extension: ".img"),
        Log.Write);

    /// <summary>Decoded photos by URL and size, costed by pixels: 16 MB, a few hundred small avatars.</summary>
    private static readonly LruCache<string, BitmapImage> Decoded = new(16L * 1024 * 1024, 2L * 1024 * 1024);

    private static readonly Coalescer<string, byte[]?> Downloads = new();
    private static readonly FailureBackoff<string> Failures = new(TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(30));
    private static readonly HttpClient Http = CreateClient();

    private static HttpClient CreateClient()
    {
        // Public images: no session, no cookies, nothing of the operator's is sent.
        var http = new HttpClient(new SocketsHttpHandler { UseCookies = false, AutomaticDecompression = System.Net.DecompressionMethods.All })
        {
            Timeout = TimeSpan.FromSeconds(15),
        };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("WebyarWindows");
        return http;
    }

    /// <summary>The picture if it is already decoded — no waiting, for the first frame of a row.</summary>
    public static BitmapImage? Peek(Uri uri, int decodeWidth) =>
        Decoded.TryGet(Key(uri, decodeWidth), out var image) ? image : null;

    public static bool ShouldTry(Uri uri) => Failures.ShouldTry(uri.AbsoluteUri, DateTimeOffset.UtcNow);

    /// <summary>
    /// Loads a photo. Must be called on the UI thread (the picture is created
    /// there); the bytes are read or downloaded on a worker. Null when it
    /// could not be loaded.
    /// </summary>
    public static async Task<BitmapImage?> LoadAsync(Uri uri, int decodeWidth)
    {
        var key = Key(uri, decodeWidth);
        if (Decoded.TryGet(key, out var known)) return known;
        var url = uri.AbsoluteUri;
        if (!Failures.ShouldTry(url, DateTimeOffset.UtcNow)) return null;
        var bytes = await Downloads.RunAsync(url, () => Task.Run(() => FetchAsync(uri)));
        if (bytes is null)
        {
            Failures.Failed(url, DateTimeOffset.UtcNow);
            return null;
        }
        try
        {
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(bytes.AsBuffer());
            stream.Seek(0);
            var image = new BitmapImage { DecodePixelWidth = decodeWidth };
            await image.SetSourceAsync(stream);
            Failures.Succeeded(url);
            Decoded.Set(key, image, Math.Max(1L, (long)decodeWidth * decodeWidth * 4));
            return image;
        }
        catch (Exception e)
        {
            // Not an image after all: forget the file so a fixed one is fetched next time.
            Log.Write($"[avatar] undecodable: {e.GetType().Name}");
            Disk.Delete(FileKey(url), null);
            Failures.Failed(url, DateTimeOffset.UtcNow);
            return null;
        }
    }

    private static async Task<byte[]?> FetchAsync(Uri uri)
    {
        var fileKey = FileKey(uri.AbsoluteUri);
        if (Disk.Read(fileKey) is { } cached) return cached;
        try
        {
            using var response = await Http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            if (response.Content.Headers.ContentLength is > MaxDownload) return null;
            var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            if (bytes.Length == 0 || bytes.Length > MaxDownload) return null;
            Disk.Write(fileKey, null, bytes);
            return bytes;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException)
        {
            return null;
        }
    }

    public static (long Bytes, int Count) Measure() => Disk.Measure();

    public static void Clear()
    {
        Disk.Clear();
        ClearMemory();
    }

    public static void ClearMemory()
    {
        Decoded.Clear();
        Failures.Clear();
    }

    public static void Trim() => Disk.Trim();

    private static string Key(Uri uri, int decodeWidth) => $"{decodeWidth}|{uri.AbsoluteUri}";

    private static string FileKey(string url) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url))).ToLowerInvariant();
}
