namespace Webyar.Core.Inbox;

public enum AvatarOs { None, Apple, Windows, Linux, Android }

/// <summary>An HSL colour, as the web console writes its gradients.</summary>
public readonly record struct Hsl(double H, double S, double L)
{
    public (byte R, byte G, byte B) ToRgb()
    {
        double s = S / 100, l = L / 100;
        var c = (1 - Math.Abs(2 * l - 1)) * s;
        var hp = H % 360 / 60;
        var x = c * (1 - Math.Abs(hp % 2 - 1));
        var (r, g, b) = hp switch
        {
            < 1 => (c, x, 0d),
            < 2 => (x, c, 0d),
            < 3 => (0d, c, x),
            < 4 => (0d, x, c),
            < 5 => (x, 0d, c),
            _ => (c, 0d, x),
        };
        var m = l - c / 2;
        static byte B(double v) => (byte)Math.Round(Math.Clamp(v, 0, 1) * 255);
        return (B(r + m), B(g + m), B(b + m));
    }
}

/// <summary>
/// What a visitor's avatar shows, computed exactly like the web console's
/// ContactAvatar (src/components/inbox/ContactAvatar.tsx): their photo; else,
/// when the operating system is known, its logo on that OS's gradient; else
/// their initials on a gradient picked by a djb2 hash of the name.
/// </summary>
public sealed record AvatarArt(AvatarOs Os, string Initials, Hsl From, Hsl To, double AngleDegrees)
{
    private static readonly (int Hue, int Sat)[] Palette =
    [
        (212, 92), (262, 78), (192, 78), (152, 62), (172, 70), (232, 88),
        (292, 70), (332, 78), (16, 86), (36, 90), (142, 64), (202, 88),
    ];

    public static AvatarArt For(string? name, string? email, string? os)
    {
        var kind = OsOf(os);
        var initials = InitialsOf(name, email);
        switch (kind)
        {
            case AvatarOs.Apple: return new(kind, initials, new(220, 8, 42), new(220, 12, 16), 140);
            case AvatarOs.Windows: return new(kind, initials, new(201, 92, 56), new(217, 90, 44), 140);
            case AvatarOs.Linux: return new(kind, initials, new(38, 96, 58), new(22, 90, 48), 140);
            case AvatarOs.Android: return new(kind, initials, new(150, 68, 50), new(142, 72, 34), 140);
        }
        var seed = (string.IsNullOrEmpty(name) ? email ?? string.Empty : name).ToLowerInvariant();
        var (h, s) = Palette[Djb2(seed.Length == 0 ? "?" : seed) % 12];
        return new(AvatarOs.None, initials, new(h, s, 56), new((h + 28) % 360, s, 44), 135);
    }

    public static AvatarOs OsOf(string? os)
    {
        var o = (os ?? string.Empty).ToLowerInvariant();
        if (o.Length == 0) return AvatarOs.None;
        if (o.Contains("mac") || o.Contains("ios") || o.Contains("iphone") || o.Contains("ipad")) return AvatarOs.Apple;
        if (o.Contains("win")) return AvatarOs.Windows;
        if (o.Contains("android")) return AvatarOs.Android;
        if (o.Contains("linux") || o.Contains("ubuntu")) return AvatarOs.Linux;
        return AvatarOs.None;
    }

    /// <summary>JavaScript's `((h &lt;&lt; 5) + h) ^ charCode` over UTF-16 units, then `&gt;&gt;&gt; 0`.</summary>
    public static uint Djb2(string s)
    {
        var h = 5381;
        foreach (var c in s) h = unchecked(((h << 5) + h) ^ c);
        return unchecked((uint)h);
    }

    public static string InitialsOf(string? name, string? email)
    {
        var src = (string.IsNullOrEmpty(name) ? email ?? string.Empty : name).Trim();
        if (src.Length == 0) return "?";
        var parts = src.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 2) return (parts[0][..1] + parts[1][..1]).ToUpperInvariant();
        return (parts[0].Length >= 2 ? parts[0][..2] : parts[0][..1]).ToUpperInvariant();
    }

    /// <summary>The emoji-free flag stand-in: Windows has no flag emoji, so the two letters.</summary>
    public static string? CountryBadge(string? countryCode) =>
        countryCode is { Length: 2 } cc && char.IsAsciiLetter(cc[0]) && char.IsAsciiLetter(cc[1]) ? cc.ToUpperInvariant() : null;
}
