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
        Engagement = new EngagementService(this);
    }

    /// <summary>Super Admin's ads, announcements and broadcasts.</summary>
    public EngagementService Engagement { get; }

    public DispatcherQueue Ui { get; }
    public AppSettings Settings { get; }
    public Strings Strings { get; private set; }
    public ApiClient Client { get; }
    public WebyarApi Api { get; }
    public Notifier Notifier { get; }
    public UpdateService Updates { get; }
    public DesktopConfig Config { get; private set; } = DesktopConfig.Defaults;

    public User? User { get; set; }

    /// <summary>The operator's profile, for their photo; loaded after sign-in, null until then.</summary>
    public Account? Account { get; set; }
    public IReadOnlyList<Workspace> Workspaces { get; set; } = [];

    /// <summary>The operator's own availability and the team's presence; null while signed out.</summary>
    public PresenceService? Presence { get; private set; }

    private readonly Dictionary<string, VisitorProfile> _profiles = [];
    private DateTimeOffset _profilesAt;

    /// <summary>
    /// Adds each visitor's OS, country and city to a page of conversations,
    /// as the web inbox does (one batched call). Known profiles are reused;
    /// the whole set is refreshed every two minutes.
    /// </summary>
    public async Task<IReadOnlyList<Conversation>> WithVisitorProfilesAsync(IReadOnlyList<Conversation> list, CancellationToken ct = default)
    {
        if (Workspace is not { } ws || list.Count == 0) return list;
        var stale = DateTimeOffset.UtcNow - _profilesAt > TimeSpan.FromMinutes(2);
        var wanted = list.Select(c => c.Id).Where(id => stale || !_profiles.ContainsKey(id)).ToList();
        if (wanted.Count > 0)
        {
            foreach (var (id, p) in await Api.VisitorProfilesAsync(ws.Id, wanted, ct)) _profiles[id] = p;
            if (stale) _profilesAt = DateTimeOffset.UtcNow;
        }
        return list.Select(c => _profiles.TryGetValue(c.Id, out var p) ? c with
        {
            VisitorOs = p.Device?.Os,
            VisitorDevice = p.Device?.Device,
            VisitorCountryCode = p.Geo?.CountryCode,
            VisitorCountryName = p.Geo?.Country,
            VisitorCity = p.Geo?.City,
            VisitorRegion = p.Geo?.Region,
        } : c).ToList();
    }

    /// <summary>The call center's waiting line, watched app-wide; null while signed out.</summary>
    public CallQueueWatcher? CallQueue { get; private set; }

    /// <summary>Raised when <see cref="Account"/> or <see cref="Presence"/> changes, for the shell's account corner.</summary>
    public event Action? MeChanged;

    /// <summary>After sign-in: the profile photo, then presence (heartbeat, team states).</summary>
    public async Task StartPresenceAsync()
    {
        StopPresence();
        try
        {
            Account = await Api.AccountAsync();
        }
        catch (Exception e)
        {
            Log.Error("account", e);
        }
        if (Workspace is { } ws)
        {
            Presence = new PresenceService(this, ws.Id);
            Presence.Changed += () => MeChanged?.Invoke();
            Presence.Start();
            CallQueue = new CallQueueWatcher(this, ws.Id);
            CallQueue.Start();
        }
        MeChanged?.Invoke();
    }

    public void StopPresence()
    {
        Presence?.Dispose();
        Presence = null;
        CallQueue?.Dispose();
        CallQueue = null;
    }
    public Workspace? Workspace { get; set; }

    /// <summary>What the workspace's plan shows; Loading until the first fetch after choosing a workspace.</summary>
    public WorkspacePlan Plan { get; private set; } = WorkspacePlan.Loading;

    /// <summary>Raised on the UI thread whenever the plan snapshot changes.</summary>
    public event Action? PlanChanged;

    /// <summary>
    /// Fetches the plan again. The super admin can switch a feature at any
    /// time, so the shell calls this every few minutes; a failure keeps the
    /// last good snapshot, and only a first failure falls back to "show all".
    /// </summary>
    public async Task LoadPlanAsync(CancellationToken ct = default)
    {
        if (Workspace is not { } ws) return;
        WorkspacePlan next;
        try
        {
            next = await Api.PlanAsync(ws.Id, ct).ConfigureAwait(false);
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            Log.Error("plan", e);
            if (Plan.State == PlanState.Loaded) return;
            next = WorkspacePlan.Failed;
        }
        if (Workspace?.Id != ws.Id) return;
        RunOnUi(() =>
        {
            Plan = next;
            PlanChanged?.Invoke();
        });
    }

    /// <summary>Forgets the plan when the workspace changes, so nothing from the old one shows.</summary>
    public void ResetPlan()
    {
        Plan = WorkspacePlan.Loading;
        _members = null;
        _profiles.Clear();
    }

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
        Engagement.Refresh();
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
        Engagement.Dispose();
        Notifier.Dispose();
        Client.Dispose();
    }
}
