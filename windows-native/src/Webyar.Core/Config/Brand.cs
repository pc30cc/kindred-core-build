namespace Webyar.Core.Config;

/// <summary>
/// The brand this build wears, fixed at build time (`-p:Brand=Respok` defines
/// BRAND_RESPOK; Directory.Build.props). One source makes two apps that install
/// side by side on one PC: WebYar for webyar.ai and RESPOK for respok.app, each
/// with its own name, server, update feed, install and data folders.
/// </summary>
public static class Brand
{
#if BRAND_RESPOK
    public const string Id = "respok";
    /// <summary>The product's name wherever the app names itself.</summary>
    public const string Name = "RESPOK";
    /// <summary>The exe and assembly name (Respok.exe), also the process name.</summary>
    public const string ExeName = "Respok";
    /// <summary>Velopack's package id; also the data folders under %APPDATA% and %LOCALAPPDATA%.</summary>
    public const string PackId = "RespokWindows";
    /// <summary>The installer people download: https://app.respok.app/downloads/RESPOK-Setup.exe.</summary>
    public const string SetupName = "RESPOK-Setup";
    /// <summary>The API a fresh install signs in to; the platform can move it later (/api/platform/origins).</summary>
    public const string ApiOrigin = "https://api.respok.app";
    /// <summary>The GitHub repository official builds are published to, as owner/repo.</summary>
    public const string ReleasesRepo = "pc30cc/respok-releases";
    /// <summary>The site's mirror of that repository's Windows feed: the apps update from here.</summary>
    public const string SiteFeed = "https://app.respok.app/downloads/windows";
    /// <summary>The product's site, as shown in the installer.</summary>
    public const string SiteHost = "respok.app";
    /// <summary>The User-Agent product token.</summary>
    public const string AgentToken = "RespokWindows";
    /// <summary>
    /// The language when Windows' own is none of the app's (fa, en, tr): English. RESPOK is the
    /// International edition, where Persian is a language to pick, never the default.
    /// </summary>
    public const Localization.Language FallbackLanguage = Localization.Language.En;
    /// <summary>Whether a first launch follows Windows' language (else <see cref="FallbackLanguage"/>).</summary>
    public const bool FollowsSystemLanguage = true;
    /// <summary>
    /// Persian dates in the Persian (Jalali) calendar. Not for RESPOK: in the International edition
    /// Persian is only right-to-left text, so its dates are Gregorian in Persian digits.
    /// </summary>
    public const bool JalaliDates = false;
#else
    public const string Id = "webyar";
    public const string Name = "Webyar";
    public const string ExeName = "Webyar";
    public const string PackId = "WebyarWindows";
    public const string SetupName = "Webyar-Setup";
    public const string ApiOrigin = "https://api.webyar.ai";
    public const string ReleasesRepo = "pc30cc/webyar-desktop-releases";
    public const string SiteFeed = "https://app.webyar.ai/downloads/windows";
    public const string SiteHost = "webyar.ai";
    public const string AgentToken = "WebyarWindows";
    public const Localization.Language FallbackLanguage = Localization.Language.Fa;
    public const bool FollowsSystemLanguage = false;
    public const bool JalaliDates = true;
#endif
}
