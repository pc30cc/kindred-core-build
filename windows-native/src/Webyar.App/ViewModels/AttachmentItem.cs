using CommunityToolkit.Mvvm.ComponentModel;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Localization;

namespace Webyar.App.ViewModels;

/// <summary>A file on a message. Photos load their preview on demand; bytes are kept in memory and on disk (<see cref="FileCache"/>).</summary>
public sealed partial class AttachmentItem : ObservableObject
{
    private static readonly Dictionary<string, byte[]> Cache = [];

    /// <summary>
    /// Decoded photos by attachment id. Each poll builds fresh items; a photo
    /// already shown comes back at once at its size instead of flashing empty.
    /// </summary>
    private static readonly Dictionary<string, (BitmapImage Image, double Width, double Height)> Previews = [];

    /// <summary>The largest a photo is drawn in the thread, either way.</summary>
    private const double MaxSide = 320;

    public AttachmentItem(MessageAttachment a, Strings s)
    {
        Id = a.Id;
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
        Glyph = Kind switch { "audio" => "", "video" => "", "image" => "", _ => "" };
    }

    /// <summary>A file the operator picked and is sending now.</summary>
    public AttachmentItem(string fileName, string mimeType, byte[] data, Strings s)
        : this(new MessageAttachment("local:" + Guid.NewGuid(), fileName, mimeType, data.LongLength), s)
    {
        Cache[Id] = data;
    }

    public string Id { get; }
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

    [ObservableProperty]
    private BitmapImage? _preview;

    [ObservableProperty]
    private double _previewWidth = 240;

    [ObservableProperty]
    private double _previewHeight = 180;

    public async Task<byte[]> BytesAsync()
    {
        if (Cache.TryGetValue(Id, out var cached)) return cached;
        var data = await Task.Run(() => FileCache.Read(Id));
        if (data is null)
        {
            data = await AppHost.Current.Api.AttachmentDataAsync(Id);
            var bytes = data;
            _ = Task.Run(() => FileCache.Write(Id, bytes));
        }
        Cache[Id] = data;
        return data;
    }

    /// <summary>Loads the thumbnail for a photo; a failure leaves the file chip instead of an error.</summary>
    public async Task LoadPreviewAsync()
    {
        if (!IsImage || Preview is not null) return;
        if (Previews.TryGetValue(Id, out var known))
        {
            Show(known);
            return;
        }
        try
        {
            var data = await BytesAsync();
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(data.AsBuffer());
            stream.Seek(0);
            var image = new BitmapImage { DecodePixelWidth = 640 };
            await image.SetSourceAsync(stream);
            var (w, h) = Fit(image.PixelWidth, image.PixelHeight);
            Previews[Id] = (image, w, h);
            Show(Previews[Id]);
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
    public static void Alias(string localId, string serverId)
    {
        if (Cache.TryGetValue(localId, out var data))
        {
            Cache[serverId] = data;
            _ = Task.Run(() => FileCache.Write(serverId, data));
        }
        if (Previews.TryGetValue(localId, out var preview)) Previews[serverId] = preview;
    }

    /// <summary>Forgets the in-memory copies too, after the disk cache is cleared.</summary>
    public static void ClearMemory()
    {
        foreach (var key in Cache.Keys.Where(k => !k.StartsWith("local:", StringComparison.Ordinal)).ToList()) Cache.Remove(key);
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
