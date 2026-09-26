namespace Webyar.Core.Config;

/// <summary>
/// Which update feeds a build trusts. The feed URL arrives from whichever
/// server the app talks to (and that can be a self-hosted address typed in on
/// the sign-in screen), while what it serves is installed with the operator's
/// rights, and the packages are not code-signed yet. So a feed is only used
/// when it is where official builds are published; anything else switches
/// self-update off.
/// </summary>
public static class UpdateFeeds
{
    /// <summary>
    /// GitHub repositories official builds are published to, as owner/repo:
    /// .github/workflows/desktop-native.yml runs `vpk upload github --repoUrl
    /// https://github.com/pc30cc/webyar-desktop-releases`.
    /// </summary>
    public static readonly IReadOnlyList<string> GithubRepos = ["pc30cc/webyar-desktop-releases"];

    /// <summary>The GitHub repository a trusted feed names, as https://github.com/owner/repo; null for any other URL.</summary>
    public static string? TrustedGithubRepo(string? feed)
    {
        if (!TryHttps(feed, out var uri) || !uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)) return null;
        var parts = uri.AbsolutePath.Trim('/').Split('/');
        if (parts.Length < 2) return null;
        var repo = $"{parts[0]}/{parts[1]}";
        return GithubRepos.FirstOrDefault(r => r.Equals(repo, StringComparison.OrdinalIgnoreCase)) is { } match
            ? $"https://github.com/{match}"
            : null;
    }

    /// <summary>
    /// Whether <paramref name="feed"/> is a plain https folder under one of
    /// <paramref name="webPrefixes"/> (extra feeds fixed at build time; none by default).
    /// </summary>
    public static bool IsTrustedWebFeed(string? feed, IEnumerable<string> webPrefixes)
    {
        if (!TryHttps(feed, out var uri)) return false;
        var path = WithSlash(uri.AbsolutePath);
        // Encoded separators or dot segments could step outside the trusted folder once decoded.
        if (path.Contains('%') || path.Contains('\\') || path.Contains("/../", StringComparison.Ordinal)) return false;
        foreach (var raw in webPrefixes)
        {
            if (!TryHttps(raw?.Trim(), out var prefix)) continue;
            if (uri.Scheme == prefix.Scheme && uri.Host.Equals(prefix.Host, StringComparison.OrdinalIgnoreCase) && uri.Port == prefix.Port &&
                path.StartsWith(WithSlash(prefix.AbsolutePath), StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    /// <summary>Whether a feed may be used at all: a trusted GitHub repository or a trusted web folder.</summary>
    public static bool IsTrusted(string? feed, IEnumerable<string> webPrefixes) =>
        TrustedGithubRepo(feed) is not null || IsTrustedWebFeed(feed, webPrefixes);

    private static string WithSlash(string path) => path.EndsWith('/') ? path : path + "/";

    private static bool TryHttps(string? text, out Uri uri)
    {
        if (text is not null && Uri.TryCreate(text, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps &&
            string.IsNullOrEmpty(u.UserInfo) && u.IsDefaultPort)
        {
            uri = u;
            return true;
        }
        uri = null!;
        return false;
    }
}
