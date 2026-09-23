using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Webyar.App.Helpers;

/// <summary>Colours computed from data: avatars, statuses, priorities.</summary>
public static class Palette
{
    // windows/src/renderer/src/components/Avatar.tsx, colour for colour.
    private static readonly Color[] AvatarColors =
    [
        C(0x3B7AF2), C(0x7C4DDB), C(0x0EA5A4), C(0xE5484D), C(0xF76B15),
        C(0x30A46C), C(0xD6409F), C(0x0091FF), C(0x8E4EC6), C(0x12A594),
    ];

    private static Color C(uint rgb, byte a = 255) => Color.FromArgb(a, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);

    /// <summary>The same 31-multiplier hash as the web console, so a name keeps its colour across apps.</summary>
    public static int Hash(string s)
    {
        var h = 0;
        foreach (var ch in s) h = unchecked(h * 31 + ch);
        return h == int.MinValue ? 0 : Math.Abs(h);
    }

    public static Color AvatarColor(string name) => AvatarColors[Hash(name) % AvatarColors.Length];

    public static Brush AvatarBrush(string name)
    {
        var c = AvatarColor(name);
        return new LinearGradientBrush
        {
            StartPoint = new Windows.Foundation.Point(0, 0),
            EndPoint = new Windows.Foundation.Point(1, 1),
            GradientStops =
            {
                new GradientStop { Color = c, Offset = 0 },
                new GradientStop { Color = Color.FromArgb(0xCC, c.R, c.G, c.B), Offset = 1 },
            },
        };
    }

    public static Brush Resource(string key) => (Brush)Application.Current.Resources[key];

    /// <summary>(foreground, background) resource keys for a conversation status chip.</summary>
    public static (string Fore, string Back) Status(string status) => status switch
    {
        "open" => ("BrandBrush", "BrandSoftBrush"),
        "pending" => ("WarningBrush", "WarningSoftBrush"),
        "resolved" or "closed" => ("SuccessBrush", "SuccessSoftBrush"),
        _ => ("Text2Brush", "ElevatedBrush"),
    };

    public static (string Fore, string Back) Priority(string? priority) => priority switch
    {
        "urgent" => ("DangerBrush", "DangerSoftBrush"),
        "high" => ("WarningBrush", "WarningSoftBrush"),
        "low" => ("Text3Brush", "ElevatedBrush"),
        _ => ("Text2Brush", "ElevatedBrush"),
    };

    public static SolidColorBrush Transparent { get; } = new(Colors.Transparent);
}
