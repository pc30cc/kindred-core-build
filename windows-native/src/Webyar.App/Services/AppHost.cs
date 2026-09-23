using Microsoft.UI.Dispatching;
using Webyar.Core.Api;
using Webyar.Core.Config;
using Webyar.Core.Localization;
using Webyar.Core.Realtime;

namespace Webyar.App.Services;

/// <summary>
/// The app's one set of services: settings, the API, translations, realtime,
/// notifications and updates. Created once at launch; pages reach it through
/// <see cref="Current"/> rather than a DI container, which this size of app does not need.
/// </summary>
public sealed class AppHost : IAsyncDisposable
{
    private static AppHost? _current;
    public static AppHost Current => _current ?? throw new InvalidOperationException("AppHost not created");

    public AppHost(DispatcherQueue ui)
    {
        _current = this;
        Ui = ui;
        Settings = AppSettings.Load();
        Strings = new Strings(Settings.ResolvedLanguage);
        var origin = Settings.ApiOrigin is { } o && Uri.TryCreate(o, UriKind.Absolute, out var u) ? u : null;
        Client = new ApiClient(new DpapiSessionStore(), origin, appVersion: typeof(AppHost).Assembly.GetName().Version?.ToString(3));
        Api = new WebyarApi(Client);
        Notifier = new Notifier();
        Updates = new UpdateService(RunOnUi);
    }

    public DispatcherQueue Ui { get; }
    public AppSettings Settings { get; }
    public Strings Strings { get; private set; }
    public ApiClient Client { get; }
    public WebyarApi Api { get; }
    public Notifier Notifier { get; }
    public UpdateService Updates { get; }
    public DesktopConfig Config { get; private set; } = DesktopConfig.Defaults;

    public User? User { get; set; }
    public IReadOnlyList<Workspace> Workspaces { get; set; } = [];
    public Workspace? Workspace { get; set; }

    private IReadOnlyList<WorkspaceMember>? _members;
    private DateTimeOffset _membersAt;
    private string? _membersWorkspace;

    /// <summary>The workspace's people, cached for ten minutes: names for "assigned to" and the transfer menu.</summary>
    public async Task<IReadOnlyList<WorkspaceMember>> MembersAsync()
    {
        if (Workspace is not { } ws) return [];
        if (_members is not null && _membersWorkspace == ws.Id && DateTimeOffset.UtcNow - _membersAt < TimeSpan.FromMinutes(10)) return _members;
        _members = await Api.MembersAsync(ws.Id);
        _membersAt = DateTimeOffset.UtcNow;
        _membersWorkspace = ws.Id;
        return _members;
    }

    /// <summary>A colleague's name from the cache, or empty when it is not loaded yet.</summary>
    public string MemberName(string userId)
    {
        if (_members is null && Workspace is not null) _ = MembersQuietlyAsync();
        return _members?.FirstOrDefault(m => m.UserId == userId)?.DisplayName ?? string.Empty;
    }

    private async Task MembersQuietlyAsync()
    {
        try
        {
            await MembersAsync();
        }
        catch (Exception e)
        {
            Log.Error("members", e);
        }
    }

    public InboxRealtime? Realtime { get; private set; }
    public bool RealtimeConnected => Realtime?.IsConnected == true;

    /// <summary>Every realtime event, on the UI thread.</summary>
    public event Action<InboxEvent>? InboxChanged;
    public event Action? LanguageChanged;

    public void RunOnUi(Action action)
    {
        if (Ui.HasThreadAccess) action();
        else Ui.TryEnqueue(() => action());
    }

    public void SetLanguage(Language language)
    {
        Settings.Language = Strings.Code(language);
        Settings.Save();
        Strings = new Strings(language);
        LanguageChanged?.Invoke();
    }

    /// <summary>Asks the platform where it lives and what it wants of desktop apps; keeps the last good answers.</summary>
    public async Task RefreshPlatformAsync()
    {
        await Client.RefreshOriginAsync().ConfigureAwait(false);
        if (Settings.ApiOrigin != Client.Origin.ToString())
        {
            Settings.ApiOrigin = Client.Origin.ToString().TrimEnd('/');
            Settings.Save();
        }
        if (await DesktopConfig.FetchAsync(Client).ConfigureAwait(false) is { } config) Config = config;
        RunOnUi(() => Updates.Configure(Config.Update));
    }

    /// <summary>
    /// How long a poller should wait. While the realtime channel is up every
    /// change arrives as an event, so polling drops to the platform's slow
    /// safety net (Super Admin → Windows app) instead of every few seconds.
    /// </summary>
    public TimeSpan PollInterval(TimeSpan normal) =>
        RealtimeConnected ? TimeSpan.FromSeconds(Config.PollWithRealtimeSeconds) : normal;

    public async Task StartRealtimeAsync()
    {
        if (Realtime is not null) await Realtime.DisposeAsync().ConfigureAwait(false);
        Realtime = null;
        if (Workspace is null) return;
        var rt = new InboxRealtime(Api, Workspace.Id, allowed: () => Config.RealtimeEnabled);
        rt.EventReceived += e => RunOnUi(() => InboxChanged?.Invoke(e));
        rt.Log += Log.Write;
        Realtime = rt;
        rt.Start();
    }

    public async ValueTask DisposeAsync()
    {
        if (Realtime is not null) await Realtime.DisposeAsync().ConfigureAwait(false);
        Notifier.Dispose();
        Client.Dispose();
    }
}
