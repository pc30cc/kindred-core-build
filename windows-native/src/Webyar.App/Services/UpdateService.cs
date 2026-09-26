using System.Diagnostics;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using Velopack;
using Velopack.Sources;
using Webyar.Core.Config;

namespace Webyar.App.Services;

public enum UpdateStatus
{
    Idle,
    Checking,
    Current,
    Downloading,
    Ready,
    Failed,
    /// <summary>Not installed through Velopack (a build run from source): nothing to update.</summary>
    Unavailable,
}

/// <summary>
/// Self-update from the feed Super Admin → Windows app names, in one of two ways:
/// <list type="bullet">
/// <item>An older per-user copy installed by Velopack updates through Velopack,
/// which reads `releases.&lt;channel&gt;.json`, downloads the package (a delta
/// when it can) and verifies it before anything runs.</item>
/// <item>The machine-wide install under Program Files (Webyar-Setup) takes the
/// newest `Webyar-Setup.exe` from the feed's GitHub releases and runs it
/// silently; Windows asks the operator to allow it, as for any installer.</item>
/// </list>
/// Either way the update applies on the next restart, or at once when the operator agrees.
/// Only feeds on the build's allow-list are used (<see cref="UpdateFeeds"/>):
/// the feed URL comes from the server, which may be a self-hosted one, and the
/// packages are not code-signed yet.
/// </summary>
public sealed partial class UpdateService : ObservableObject
{
    private UpdateManager? _manager;
    private string? _feed;
    private string? _channel;
    private string? _rejectedFeed;
    private UpdateInfo? _pending;
    /// <summary>Program Files install: the downloaded installer waiting to run.</summary>
    private string? _pendingSetup;
    private bool _prerelease;
    private static readonly HttpClient Http = CreateHttp();

    private static HttpClient CreateHttp()
    {
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("Webyar-Windows");
        return http;
    }

    /// <summary>Installed by Webyar-Setup (Program Files) rather than by Velopack.</summary>
    private bool SetupInstalled => _manager is { IsInstalled: false } && File.Exists(Path.Combine(AppContext.BaseDirectory, "Uninstall Webyar.exe"));
    private Timer? _timer;
    private int _busy;
    private readonly Action<Action> _ui;

    /// <param name="ui">Runs an action on the UI thread; bound properties may only change there.</param>
    public UpdateService(Action<Action> ui) => _ui = ui;

    [ObservableProperty]
    private UpdateStatus _status = UpdateStatus.Idle;

    [ObservableProperty]
    private int _progress;

    [ObservableProperty]
    private string? _availableVersion;

    [ObservableProperty]
    private bool _required;

    /// <summary>Where releases are published when Super Admin names no feed.</summary>
    public const string DefaultFeed = "https://github.com/pc30cc/webyar-desktop-releases";

    /// <summary>
    /// Extra https feed folders this build trusts, fixed at build time:
    /// the WebyarUpdateFeeds MSBuild property / environment variable (see Webyar.App.csproj).
    /// </summary>
    private static readonly string[] ExtraFeeds =
        (typeof(UpdateService).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "WebyarUpdateFeeds")?.Value ?? string.Empty)
        .Split(new[] { ';', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>
    /// A trusted GitHub repository (or any URL inside it) is read through its releases, picking the newest
    /// one that carries a Velopack feed (the repository may hold other apps'
    /// releases too); a trusted web folder is a plain folder of Velopack files.
    /// Null for any feed not on the allow-list.
    /// </summary>
    internal static IUpdateSource? SourceFor(string feed, bool prerelease)
    {
        // https://github.com/<owner>/<repo>, or any page under it such as …/releases/latest/download.
        if (UpdateFeeds.TrustedGithubRepo(feed) is { } repo) return new GithubSource(repo, null, prerelease);
        if (UpdateFeeds.IsTrustedWebFeed(feed, ExtraFeeds)) return new SimpleWebSource(feed);
        return null;
    }

    public string CurrentVersion => (_manager is { IsInstalled: true } ? _manager.CurrentVersion?.ToString() : null)
        ?? typeof(UpdateService).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>Applies the platform's settings; safe to call again whenever they are re-read.</summary>
    public void Configure(UpdateSettings settings)
    {
        var feed = settings.FeedUrl ?? DefaultFeed;
        var channel = settings.Channel == "beta" ? "beta" : null; // null: Velopack's default channel
        if (feed != _feed || channel != _channel)
        {
            if (SourceFor(feed, channel is not null) is not { } source)
            {
                // Not an official feed: check, download and install nothing, not even on exit.
                if (feed != _rejectedFeed) Log.Write($"update feed {feed} is not on the allow-list; self-update is off");
                _rejectedFeed = feed;
                _feed = null;
                _manager = null;
                _pending = null;
                _pendingSetup = null;
                _timer?.Dispose();
                _timer = null;
                Status = UpdateStatus.Unavailable;
                return;
            }
            _rejectedFeed = null;
            _feed = feed;
            _channel = channel;
            _manager = new UpdateManager(source, new UpdateOptions { ExplicitChannel = channel });
        }
        _prerelease = channel is not null;
        if (!_manager.IsInstalled && !SetupInstalled)
        {
            Status = UpdateStatus.Unavailable;
            return;
        }
        if (Version.TryParse(CurrentVersion.Split('-')[0], out var current)) Required = settings.IsBelowMinimum(current);
        _timer?.Dispose();
        if (settings.AutoUpdate)
        {
            var every = TimeSpan.FromMinutes(settings.CheckIntervalMinutes);
            _timer = new Timer(_ => _ = CheckAsync(), null, TimeSpan.FromSeconds(15), every);
        }
    }

    public async Task CheckAsync()
    {
        var manager = _manager;
        // Status is set through the UI thread, so it lags; this flag is the real guard.
        if (manager is null || (!manager.IsInstalled && !SetupInstalled) || _pending is not null || _pendingSetup is not null || Interlocked.Exchange(ref _busy, 1) == 1) return;
        try
        {
            if (!manager.IsInstalled)
            {
                await CheckSetupAsync().ConfigureAwait(false);
                return;
            }
            _ui(() => Status = UpdateStatus.Checking);
            var info = await manager.CheckForUpdatesAsync().ConfigureAwait(false);
            if (info is null)
            {
                _ui(() => Status = UpdateStatus.Current);
                return;
            }
            var version = info.TargetFullRelease.Version.ToString();
            _ui(() =>
            {
                AvailableVersion = version;
                Status = UpdateStatus.Downloading;
            });
            await manager.DownloadUpdatesAsync(info, p => _ui(() => Progress = p)).ConfigureAwait(false);
            _pending = info;
            _ui(() => Status = UpdateStatus.Ready);
            Log.Write($"update {version} downloaded");
        }
        catch (Exception e)
        {
            Log.Error("update", e);
            _ui(() => Status = UpdateStatus.Failed);
        }
        finally
        {
            Volatile.Write(ref _busy, 0);
        }
    }

    /// <summary>
    /// Program Files install: the newest release that carries Webyar-Setup.exe,
    /// downloaded when it is newer than this build.
    /// </summary>
    private async Task CheckSetupAsync()
    {
        _ui(() => Status = UpdateStatus.Checking);
        var release = await LatestSetupAsync().ConfigureAwait(false);
        if (release is null || !SemVer.TryParse(release.Value.Version, out var latest) ||
            !SemVer.TryParse(CurrentVersion, out var current) || SemVer.Compare(latest, current) <= 0)
        {
            _ui(() => Status = UpdateStatus.Current);
            return;
        }
        var version = release.Value.Version.TrimStart('v', 'V');
        _ui(() =>
        {
            AvailableVersion = version;
            Status = UpdateStatus.Downloading;
        });
        var dir = Path.Combine(Path.GetTempPath(), "WebyarUpdate");
        Directory.CreateDirectory(dir);
        var target = Path.Combine(dir, $"Webyar-Setup-{version}.exe");
        var part = target + ".part";
        using (var response = await Http.GetAsync(release.Value.Url, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
        {
            response.EnsureSuccessStatusCode();
            var total = response.Content.Headers.ContentLength ?? 0;
            await using var src = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
            await using (var dst = File.Create(part))
            {
                var buffer = new byte[1 << 16];
                long done = 0;
                int read, last = -1;
                while ((read = await src.ReadAsync(buffer).ConfigureAwait(false)) > 0)
                {
                    await dst.WriteAsync(buffer.AsMemory(0, read)).ConfigureAwait(false);
                    done += read;
                    var pct = total > 0 ? (int)(done * 100 / total) : 0;
                    if (pct != last) { last = pct; _ui(() => Progress = pct); }
                }
            }
        }
        File.Move(part, target, overwrite: true);
        _pendingSetup = target;
        _ui(() => Status = UpdateStatus.Ready);
        Log.Write($"update {version} downloaded (setup)");
    }

    /// <summary>
    /// The feed's GitHub releases, newest first; stable only unless the channel is beta.
    /// Only a trusted repository is asked, and only an installer published in
    /// its own releases is taken.
    /// </summary>
    private async Task<(string Version, string Url)?> LatestSetupAsync()
    {
        if (UpdateFeeds.TrustedGithubRepo(_feed ?? DefaultFeed) is not { } repo) return null;
        var ownerRepo = repo["https://github.com/".Length..];
        var json = await Http.GetStringAsync($"https://api.github.com/repos/{ownerRepo}/releases?per_page=15").ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        foreach (var rel in doc.RootElement.EnumerateArray())
        {
            if (rel.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
            if (!_prerelease && rel.TryGetProperty("prerelease", out var pre) && pre.GetBoolean()) continue;
            if (!rel.TryGetProperty("assets", out var assets)) continue;
            foreach (var asset in assets.EnumerateArray())
            {
                if (asset.GetProperty("name").GetString() != "Webyar-Setup.exe") continue;
                var url = asset.GetProperty("browser_download_url").GetString() ?? "";
                if (!url.StartsWith(repo + "/releases/download/", StringComparison.OrdinalIgnoreCase)) continue;
                return (rel.GetProperty("tag_name").GetString() ?? "", url);
            }
        }
        return null;
    }

    /// <summary>Runs the downloaded installer silently (Windows asks to allow it); it reopens Webyar when done.</summary>
    private bool RunSetup()
    {
        if (_pendingSetup is null || !File.Exists(_pendingSetup)) return false;
        try
        {
            Process.Start(new ProcessStartInfo(_pendingSetup, "/silent /launch") { UseShellExecute = true, Verb = "runas" });
            return true;
        }
        catch (Exception e)
        {
            // The operator declined the Windows prompt: the update waits for the next try.
            Log.Error("run setup", e);
            return false;
        }
    }

    /// <summary>Quits, applies the downloaded update and starts the new version.</summary>
    public void ApplyAndRestart()
    {
        if (_pendingSetup is not null)
        {
            if (RunSetup()) Environment.Exit(0);
            return;
        }
        if (_manager is null || _pending is null) return;
        _manager.ApplyUpdatesAndRestart(_pending.TargetFullRelease);
    }

    /// <summary>On the next quit, apply what is downloaded without asking.</summary>
    public void ApplyOnExit()
    {
        // A machine-wide install needs the operator's consent, which a quit cannot ask for:
        // the downloaded installer waits for "Restart and update" instead.
        if (_manager is null || _pending is null) return;
        try
        {
            _manager.WaitExitThenApplyUpdates(_pending.TargetFullRelease, silent: true, restart: false);
        }
        catch (Exception e)
        {
            Log.Error("apply on exit", e);
        }
    }
}
