using Microsoft.UI.Dispatching;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Config;
using Webyar.Core.Local;
using Webyar.Core.Localization;
using Webyar.Core.Realtime;
using Webyar.Core.Sync;

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
        Threads = new ThreadSync(Api, null, log: Log.Write);
        Lists = new ConversationListSync(Api, null, Log.Write);
        Callers = new CallerProfiles(this);
    }

    // ── The PC's copy of the operator's inbox (local-first) ──

    /// <summary>
    /// The signed-in operator's conversations and messages on this PC, or null
    /// (signed out, or the file could not be used — everything then works
    /// from the server as before). Never another account's: it is opened for
    /// one user id and replaced whenever that changes.
    /// </summary>
    public LocalStore? Local { get; private set; }

    /// <summary>Threads: the PC's copy first, then only what changed on the server.</summary>
    public ThreadSync Threads { get; private set; }

    /// <summary>Inbox queues: the PC's copy first, then revalidated with the server.</summary>
    public ConversationListSync Lists { get; private set; }

    private int _scope;

    /// <summary>
    /// Changes with every workspace switch, sign-out or account change. Work
    /// that started under one scope compares it before showing its result,
    /// so an answer for the old workspace never lands in the new one.
    /// </summary>
    public int Scope => Volatile.Read(ref _scope);

    /// <summary>
    /// Opens the PC's copy for this operator (reusing it when it is already
    /// theirs) and remembers whose session this is, for an offline launch.
    /// </summary>
    public async Task AttachAccountAsync(User user)
    {
        if (Settings.SessionUserId != user.Id)
        {
            Settings.SessionUserId = user.Id;
            Settings.Save();
        }
        if (Local?.Owner == user.Id) return;
        await DetachAccountAsync(deleteData: false);
        LocalStore? store = null;
        try
        {
            store = await LocalStore.OpenAsync(AppPaths.LocalData, user.Id, Log.Write);
        }
        catch (Exception e)
        {
            Log.Error("open local store", e);
        }
        Local = store;
        Threads = new ThreadSync(Api, store, log: Log.Write);
        Lists = new ConversationListSync(Api, store, Log.Write);
        if (store is not null)
        {
            _ = store.EnforceRetentionAsync(RetentionPolicy.Default, DateTimeOffset.UtcNow);
            Log.Write($"[store] opened ({store.SizeOnDisk() / 1024} KB)");
        }
    }

    /// <summary>What the last launch knew: the operator and their workspaces, straight from the PC.</summary>
    public async Task<(User? User, IReadOnlyList<Workspace> Workspaces)> RestoreSessionAsync(string userId)
    {
        await AttachAccountAsync(new User(userId));
        return Local is { } store ? await store.LoadSessionAsync() : (null, []);
    }

    /// <summary>Keeps the operator and their workspaces on the PC for the next (possibly offline) launch.</summary>
    public async Task SaveSessionAsync()
    {
        if (User is { } user && Local is { Owner: var owner } store && owner == user.Id) await store.SaveSessionAsync(user, Workspaces);
    }

    /// <summary>
    /// Closes the operator's copy. Every sync still in flight is cut off from
    /// it — a late answer can no longer be written anywhere — and nothing of
    /// theirs stays in memory. <paramref name="deleteData"/> (an explicit sign-out)
    /// also deletes the file; after a lapsed session it is kept, and reused
    /// only if the same account signs in again.
    /// </summary>
    public async Task DetachAccountAsync(bool deleteData)
    {
        Interlocked.Increment(ref _scope);
        Threads.Close();
        Lists.Close();
        Threads = new ThreadSync(Api, null, log: Log.Write);
        Lists = new ConversationListSync(Api, null, Log.Write);
        var store = Local;
        Local = null;
        if (store is not null)
        {
            await store.DisposeAsync();
            if (deleteData)
            {
                LocalStore.DeleteFiles(AppPaths.LocalData, store.Owner);
                Log.Write("[store] account data deleted on sign-out");
            }
        }
        AttachmentItem.ClearAll();
        AvatarImages.ClearMemory();
        _profiles.Clear();
        Callers.Clear();
        _members = null;
        Log.Write($"[cache] after sign-out: {Client.Traffic}");
    }

    /// <summary>A workspace switch: in-flight work of the old one is disowned before the new one draws.</summary>
    public void BeginWorkspaceScope()
    {
        Interlocked.Increment(ref _scope);
        Threads.ClearMemory();
        Lists.ClearMemory();
        AttachmentItem.ClearMemory();
        _profiles.Clear();
        Callers.Clear();
    }

    /// <summary>
    /// Clear cache: the conversations and messages on this PC (every
    /// account's), downloaded files, profile photos and every memory copy.
    /// The session, the settings and anything on the server are untouched,
    /// and the open views simply sync again.
    /// </summary>
    public async Task ClearLocalDataAsync()
    {
        Interlocked.Increment(ref _scope);
        Threads.ClearMemory();
        Lists.ClearMemory();
        if (Local is { } store)
        {
            await store.ClearAsync();
            await SaveSessionAsync();
        }
        await Task.Run(() =>
        {
            LocalStore.DeleteAllFiles(AppPaths.LocalData, Local?.FilePath);
            FileCache.Clear();
            AvatarImages.Clear();
            OpenedFiles.Clear();
        });
        AttachmentItem.ClearMemory();
        _profiles.Clear();
        Log.Write("[cache] cleared by the operator");
    }

    /// <summary>What the PC keeps, for the settings page: conversation data, message files, photos.</summary>
    public static (long Data, long Files, long Photos) MeasureLocalData()
    {
        var data = LocalStore.MeasureFiles(AppPaths.LocalData);
        var (files, _) = FileCache.Measure();
        var (photos, _) = AvatarImages.Measure();
        return (data, files, photos);
    }

    /// <summary>One line of counters for the log: requests, bytes, cache hits. Never content.</summary>
    public void LogCacheStats() =>
        Log.Write($"[cache] api {Client.Traffic}; threads {Threads.Stats}; lists fetches={Lists.Fetches} notModified={Lists.NotModified} coalesced={Lists.Coalesced}; files {AttachmentStore.Stats()}");

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
        var scope = Scope;
        var stale = DateTimeOffset.UtcNow - _profilesAt > TimeSpan.FromMinutes(2);
        var wanted = list.Where(c => c.WorkspaceId == ws.Id).Select(c => c.Id).Where(id => stale || !_profiles.ContainsKey(id)).ToList();
        if (wanted.Count > 0)
        {
            var fetched = await Api.VisitorProfilesAsync(ws.Id, wanted, ct);
            // Switched workspace (or signed out) meanwhile: these belong to the old one.
            if (scope != Scope) return list;
            foreach (var (id, p) in fetched) _profiles[id] = p;
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

    /// <summary>Callers' OS and country by visitor session, for their faces on the desk, the banner and the call.</summary>
    public CallerProfiles Callers { get; }

    /// <summary>The call center's waiting line, watched app-wide; null while signed out.</summary>
    public CallQueueWatcher? CallQueue { get; private set; }

    /// <summary>Raised when <see cref="Account"/> or <see cref="Presence"/> changes, for the shell's account corner.</summary>
    public event Action? MeChanged;

    /// <summary>After sign-in: the profile photo, then presence (heartbeat, team states).</summary>
    public async Task StartPresenceAsync()
    {
        StopPresence();
        // Presence and the call queue start at once; the profile photo follows
        // when the server answers (or not at all offline), never holding up the shell.
        if (Workspace is { } ws)
        {
            Presence = new PresenceService(this, ws.Id);
            Presence.Changed += () => MeChanged?.Invoke();
            Presence.Start();
            CallQueue = new CallQueueWatcher(this, ws.Id);
            CallQueue.Start();
        }
        MeChanged?.Invoke();
        var scope = Scope;
        try
        {
            var account = await Api.AccountAsync();
            if (scope != Scope || User is null) return;
            Account = account;
            MeChanged?.Invoke();
        }
        catch (Exception e)
        {
            Log.Error("account", e);
        }
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
    /// time, so the shell calls this every few minutes. Each answer is kept on
    /// the PC; a failure keeps the last good snapshot (this session's, else the
    /// PC's), and only with neither is the plan Failed — gated sections hidden,
    /// as the web does, and the shell asks again sooner.
    /// </summary>
    public async Task LoadPlanAsync(CancellationToken ct = default)
    {
        if (Workspace is not { } ws) return;
        var store = Local;
        WorkspacePlan next;
        try
        {
            next = await Api.PlanAsync(ws.Id, ct).ConfigureAwait(false);
            if (store is not null && next.Serialize() is { } json) await store.SavePlanAsync(ws.Id, json, CancellationToken.None).ConfigureAwait(false);
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            Log.Error("plan", e);
            if (Plan.State == PlanState.Loaded) return;
            next = await CachedPlanAsync(store, ws.Id).ConfigureAwait(false) ?? WorkspacePlan.Failed;
        }
        if (Workspace?.Id != ws.Id) return;
        RunOnUi(() =>
        {
            if (Workspace?.Id != ws.Id) return;
            Plan = next;
            PlanChanged?.Invoke();
        });
    }

    /// <summary>
    /// The plan this PC last saw for the workspace, shown until the server
    /// answers: the rail and composer are right from the first frame, and an
    /// offline launch shows exactly the plan's sections instead of all of them.
    /// </summary>
    public async Task RestorePlanAsync()
    {
        if (Workspace is not { } ws) return;
        var cached = await CachedPlanAsync(Local, ws.Id);
        if (cached is null || Workspace?.Id != ws.Id || Plan.State != PlanState.Loading) return;
        Plan = cached;
        PlanChanged?.Invoke();
    }

    private static async Task<WorkspacePlan?> CachedPlanAsync(LocalStore? store, string workspaceId) =>
        store is null ? null : WorkspacePlan.Restore(await store.LoadPlanAsync(workspaceId).ConfigureAwait(false));

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

    /// <summary>The realtime channel came up (true) or went down (false), on the UI thread.</summary>
    public event Action<bool>? RealtimeChanged;
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
        rt.EventReceived += e => RunOnUi(() => { if (Realtime == rt) InboxChanged?.Invoke(e); });
        // Either way the pollers must hear it at once: after a drop they go back
        // to the short interval, and after a (re)connect whatever was missed
        // while the socket was down is fetched now — deltas, not full threads.
        rt.ConnectionChanged += up => RunOnUi(() => { if (Realtime == rt) RealtimeChanged?.Invoke(up); });
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
