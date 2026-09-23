using CommunityToolkit.Mvvm.ComponentModel;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Localization;

namespace Webyar.App.ViewModels;

/// <summary>A file on a message. Photos load their preview on demand; bytes are cached for the session.</summary>
public sealed partial class AttachmentItem : ObservableObject
{
    private static readonly Dictionary<string, byte[]> Cache = [];

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

    public async Task<byte[]> BytesAsync()
    {
        if (Cache.TryGetValue(Id, out var cached)) return cached;
        var data = await AppHost.Current.Api.AttachmentDataAsync(Id);
        Cache[Id] = data;
        return data;
    }

    /// <summary>Loads the thumbnail for a photo; a failure leaves the file chip instead of an error.</summary>
    public async Task LoadPreviewAsync()
    {
        if (!IsImage || Preview is not null) return;
        try
        {
            var data = await BytesAsync();
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(data.AsBuffer());
            stream.Seek(0);
            var image = new BitmapImage { DecodePixelWidth = 560 };
            await image.SetSourceAsync(stream);
            Preview = image;
        }
        catch (Exception e)
        {
            Log.Error("attachment preview", e);
        }
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
