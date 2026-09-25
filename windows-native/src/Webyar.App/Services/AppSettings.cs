using System.Text.Json;
using Webyar.Core.Localization;

namespace Webyar.App.Services;

public enum Appearance
{
    System,
    Light,
    Dark,
}

/// <summary>This machine's preferences. The operator's account settings live on the server.</summary>
public sealed class AppSettings
{
    public string? Language { get; set; }
    public Appearance Appearance { get; set; } = Appearance.System;
    public bool Notifications { get; set; } = true;
    public bool NotificationSound { get; set; } = true;
    /// <summary>Closing the window keeps the app in the tray, so notifications still arrive.</summary>
    public bool CloseToTray { get; set; } = true;
    public bool StartWithWindows { get; set; }
    public string? ApiOrigin { get; set; }
    public string? WorkspaceId { get; set; }

    /// <summary>
    /// Whose session the saved token is (a user id, never the token): which
    /// account's copy on this PC may be shown before the server has answered.
    /// Set at sign-in, cleared when the session ends.
    /// </summary>
    public string? SessionUserId { get; set; }
    public WindowBounds? Window { get; set; }

    /// <summary>Ads and announcements the operator closed with ✕.</summary>
    public List<string> DismissedCampaigns { get; set; } = [];

    /// <summary>The last Super Admin broadcast shown, so a restart does not replay it.</summary>
    public long? LastBroadcastSeq { get; set; }

    [System.Text.Json.Serialization.JsonIgnore]
    public Language ResolvedLanguage =>
        Strings.Parse(Language) ?? Core.Localization.Language.Fa;

    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(AppPaths.Settings))
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(AppPaths.Settings), Options) ?? new AppSettings();
        }
        catch (Exception e) when (e is JsonException or IOException)
        {
            Log.Error("load settings", e);
        }
        return new AppSettings();
    }

    public void Save()
    {
        try
        {
            File.WriteAllText(AppPaths.Settings, JsonSerializer.Serialize(this, Options));
        }
        catch (IOException e)
        {
            Log.Error("save settings", e);
        }
    }
}

public sealed record WindowBounds(int X, int Y, int Width, int Height, bool Maximized);
