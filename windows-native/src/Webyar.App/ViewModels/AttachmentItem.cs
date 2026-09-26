using CommunityToolkit.Mvvm.ComponentModel;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Caching;
using Webyar.Core.Localization;
using Webyar.Core.Sync;

namespace Webyar.App.ViewModels;

/// <summary>
/// A file on a message. Photos load their preview as the thread renders;
/// voice notes, videos and documents only when played or opened
/// (<see cref="AttachmentPolicy"/>). Bytes come through <see cref="AttachmentStore"/>.
/// </summary>
public sealed partial class AttachmentItem : ObservableObject
{
    /// <summary>
    /// Decoded photos by attachment id. Each sync builds fresh items; a photo
    /// already shown comes back at once at its size instead of flashing empty.
    /// Bounded by decoded size (width × height × 4 bytes): 48 MB of pixels,
    /// about forty 640 px photos — the ones in the threads just looked at.
    /// </summary>
    private static readonly LruCache<string, (BitmapImage Image, double Width, double Height)> Previews = new(48L * 1024 * 1024, 16L * 1024 * 1024);

    /// <summary>The largest a photo is drawn in the thread, either way.</summary>
    private const double MaxSide = 320;

    public AttachmentItem(MessageAttachment a, Strings s)
    {
        Id = a.Id;
        // Captured once: a file belongs to the workspace whose thread showed it.
        WorkspaceId = AppHost.Current.Workspace?.Id;
        MimeType = a.MimeType ?? string.Empty;
        Kind = a.Kind is "image" or "audio" or "video" or "file" ? a.Kind
            : MimeType.StartsWith("image/", StringComparison.Ordinal) ? "image"
            : MimeType.StartsWith("audio/", StringComparison.Ordinal) ? "audio"
            : MimeType.StartsWith("video/", StringComparison.Ordinal) ? "video" : "file";
        // Some channels send a bare extension as the name; that tells nobody anything.
        var name = (a.FileName ?? string.Empty).Trim();
        FileName = name.Contains('.') && name.Length > 4 ? name : Kind switch
        {
            "image" => s["photo"],
            "audio" => s["voiceNote"],
            "video" => s["videoFile"],
            _ => s["file"],
        };
        SizeText = a.SizeBytes is { } b ? FormatSize(b, s) : string.Empty;
        IsImage = Kind == "image";
        IsAudio = Kind == "audio";
        ImageVisibility = IsImage ? Visibility.Visible : Visibility.Collapsed;
        AudioVisibility = IsAudio ? Visibility.Visible : Visibility.Collapsed;
        FileVisibility = IsImage || IsAudio ? Visibility.Collapsed : Visibility.Visible;
        Glyph = Kind switch { "audio" => "", "video" => "", "image" => "", _ => "" };
    }

    /// <summary>A file the operator picked and is sending now.</summary>
    public AttachmentItem(string fileName, string mimeType, byte[] data, Strings s)
        : this(new MessageAttachment("local:" + Guid.NewGuid(), fileName, mimeType, data.LongLength), s)
    {
        AttachmentStore.AddOutgoing(Id, data);
    }

    public string Id { get; }
    public string? WorkspaceId { get; }
    public string MimeType { get; }
    public string Kind { get; }
    public string FileName { get; }
    public string SizeText { get; }
    public string Glyph { get; }
    public bool IsImage { get; }
    public bool IsAudio { get; }
    public Visibility ImageVisibility { get; }
    public Visibility AudioVisibility { get; }
    public Visibility FileVisibility { get; }

    /// <summary>Fetched as soon as the message is drawn (photos only); the rest wait for the operator.</summary>
    public bool FetchOnRender => AttachmentPolicy.FetchOnRender(Kind);

    [ObservableProperty]
    private BitmapImage? _preview;

    [ObservableProperty]
    private double _previewWidth = 240;

    [ObservableProperty]
    private double _previewHeight = 180;

    public Task<byte[]> BytesAsync() => AttachmentStore.GetAsync(Id, WorkspaceId);

    /// <summary>Loads the thumbnail for a photo; a failure leaves the file chip instead of an error.</summary>
    public async Task LoadPreviewAsync()
    {
        if (!IsImage || Preview is not null) return;
        if (Previews.TryGet(Id, out var known))
        {
            Show(known);
            return;
        }
        try
        {
            // There is no thumbnail endpoint: the photo itself is fetched (once,
            // then from the PC) and only decoded small, which saves memory, not bandwidth.
            var data = await BytesAsync();
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(data.AsBuffer());
            stream.Seek(0);
            var image = new BitmapImage { DecodePixelWidth = 640 };
            await image.SetSourceAsync(stream);
            var (w, h) = Fit(image.PixelWidth, image.PixelHeight);
            var entry = (image, w, h);
            Previews.Set(Id, entry, Math.Max(1L, (long)image.PixelWidth * image.PixelHeight * 4));
            Show(entry);
        }
        catch (Exception e)
        {
            Log.Error("attachment preview", e);
        }
    }

    private void Show((BitmapImage Image, double Width, double Height) p)
    {
        PreviewWidth = p.Width;
        PreviewHeight = p.Height;
        Preview = p.Image;
    }

    /// <summary>
    /// A fixed box in the photo's own proportions. Letting the image size its
    /// cell made the row re-measure on every hover — the bubble blinked and jumped.
    /// </summary>
    private static (double Width, double Height) Fit(int pw, int ph)
    {
        if (pw <= 0 || ph <= 0) return (240, 180);
        var scale = Math.Min(1, Math.Min(MaxSide / pw, MaxSide / ph));
        var w = Math.Max(120, Math.Round(pw * scale));
        var h = Math.Max(90, Math.Round(ph * scale));
        return (w, h);
    }

    /// <summary>
    /// A file the operator just sent now has its server id: the bytes and the
    /// decoded photo carry over, so the confirmed message does not reload it.
    /// </summary>
    public static void Alias(string localId, string serverId, string? workspaceId = null)
    {
        AttachmentStore.Alias(localId, serverId, workspaceId ?? AppHost.Current.Workspace?.Id);
        if (Previews.TryGet(localId, out var preview))
        {
            Previews.Set(serverId, preview, Math.Max(1L, (long)preview.Image.PixelWidth * preview.Image.PixelHeight * 4));
            Previews.Remove(localId);
        }
    }

    /// <summary>A picked file that will not be sent (the thread was left with the send failed).</summary>
    public static void Forget(string localId)
    {
        AttachmentStore.Forget(localId);
        Previews.Remove(localId);
    }

    /// <summary>Forgets the in-memory copies too, after the disk cache is cleared.</summary>
    public static void ClearMemory()
    {
        AttachmentStore.ClearMemory();
        Previews.Clear();
    }

    /// <summary>Sign-out: no decoded photo or bytes of the last operator stay in memory.</summary>
    public static void ClearAll()
    {
        AttachmentStore.ClearAll();
        Previews.Clear();
    }

    public static string FormatSize(long bytes, Strings s)
    {
        var (value, unit) = bytes switch
        {
            < 1024 => (bytes.ToString(System.Globalization.CultureInfo.InvariantCulture), "unitBytes"),
            < 1024 * 1024 => ((bytes / 1024d).ToString("0", System.Globalization.CultureInfo.InvariantCulture), "unitKilobytes"),
            _ => ((bytes / 1024d / 1024d).ToString("0.#", System.Globalization.CultureInfo.InvariantCulture), "unitMegabytes"),
        };
        return $"{Digits.Localize(value, s.Language)} {s[unit]}";
    }
}
