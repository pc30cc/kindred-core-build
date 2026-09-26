using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Webyar.App.Helpers;

/// <summary>Colours computed from data: avatars, statuses, priorities.</summary>
public static class Palette
{
    /// <summary>The same 31-multiplier hash as the web console, so a seed keeps its pattern across apps.</summary>
    public static int Hash(string s)
    {
        var h = 0;
        foreach (var ch in s) h = unchecked(h * 31 + ch);
        return h == int.MinValue ? 0 : Math.Abs(h);
    }

    /// <summary>
    /// The theme the window actually shows. The app follows the in-app
    /// appearance setting on the root element, so a plain lookup in
    /// Application.Resources (which follows Windows) would hand out light
    /// brushes in dark mode.
    /// </summary>
    public static ElementTheme Theme { get; private set; } = ElementTheme.Light;

    /// <summary>Raised after the theme changes, so code-built brushes can be picked again.</summary>
    public static event Action? ThemeChanged;

    public static void SetTheme(ElementTheme theme)
    {
        if (theme == Theme) return;
        Theme = theme;
        ThemeChanged?.Invoke();
    }

    public static Brush Resource(string key)
    {
        var resources = Application.Current.Resources;
        if (resources.ThemeDictionaries.TryGetValue(Theme == ElementTheme.Dark ? "Dark" : "Light", out var d) &&
            d is ResourceDictionary themed && themed.TryGetValue(key, out var value) && value is Brush brush)
            return brush;
        return (Brush)resources[key];
    }

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
