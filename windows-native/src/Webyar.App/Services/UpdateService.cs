using System.Reflection;
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
/// Self-update through Velopack from the feed Super Admin → Windows app names.
/// Velopack reads `releases.&lt;channel&gt;.json` there, downloads the new
/// package (a delta when it can) and verifies it before anything runs; the
/// update applies on the next restart, or at once when the operator agrees.
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

    public string CurrentVersion => _manager?.CurrentVersion?.ToString()
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
        if (!_manager.IsInstalled)
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
        if (manager is null || !manager.IsInstalled || _pending is not null || Interlocked.Exchange(ref _busy, 1) == 1) return;
        try
        {
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

    /// <summary>Quits, applies the downloaded update and starts the new version.</summary>
    public void ApplyAndRestart()
    {
        if (_manager is null || _pending is null) return;
        _manager.ApplyUpdatesAndRestart(_pending.TargetFullRelease);
    }

    /// <summary>On the next quit, apply what is downloaded without asking.</summary>
    public void ApplyOnExit()
    {
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
