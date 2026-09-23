using Microsoft.UI;
using Microsoft.UI.Xaml.Media;
using Webyar.Core.Localization;
using Windows.UI;

namespace Webyar.App.Services;

/// <summary>
/// How a channel is shown: its name in the app's language, a glyph and its
/// brand colour, for the channel chip on conversation rows and the inbox menu.
/// </summary>
public static class ChannelInfo
{
    public static string Label(string key, Strings s) => key switch
    {
        "telegram" => s["channelTelegram"],
        "bale" => s["channelBale"],
        "whatsapp" => s["channelWhatsapp"],
        "instagram" => s["channelInstagram"],
        "x" => s["channelX"],
        "email" => s["channelEmail"],
        "phone" => s["channelPhone"],
        "widget" => s["channelWidget"],
        _ => key,
    };

    public static string Glyph(string key) => key switch
    {
        "telegram" or "bale" => "",
        "whatsapp" => "",
        "instagram" => "",
        "email" => "",
        "phone" => "",
        "x" => "",
        _ => "",
    };

    /// <summary>Each network's own colour, so the chip reads at a glance.</summary>
    public static Color Color(string key) => key switch
    {
        "telegram" => Windows.UI.Color.FromArgb(255, 0x22, 0x9E, 0xD9),
        "bale" => Windows.UI.Color.FromArgb(255, 0x1F, 0xA8, 0x6A),
        "whatsapp" => Windows.UI.Color.FromArgb(255, 0x1E, 0xB8, 0x5A),
        "instagram" => Windows.UI.Color.FromArgb(255, 0xD6, 0x29, 0x76),
        "x" => Windows.UI.Color.FromArgb(255, 0x55, 0x5B, 0x66),
        "email" => Windows.UI.Color.FromArgb(255, 0xE0, 0x8A, 0x1E),
        "phone" => Windows.UI.Color.FromArgb(255, 0x10, 0xA3, 0x7F),
        _ => Windows.UI.Color.FromArgb(255, 0x3B, 0x6E, 0xF5),
    };

    public static SolidColorBrush Brush(string key) => new(Color(key));

    /// <summary>The same colour, faint, for the chip's background.</summary>
    public static SolidColorBrush SoftBrush(string key)
    {
        var c = Color(key);
        return new SolidColorBrush(Windows.UI.Color.FromArgb(0x24, c.R, c.G, c.B));
    }
}
