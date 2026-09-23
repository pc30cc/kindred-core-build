using Webyar.App.Helpers;
using Webyar.Core.Api;
using Webyar.Core.Localization;

namespace Webyar.App.Services;

/// <summary>
/// The operator's own presence, worked out the way the web console does:
/// <list type="bullet">
/// <item>visitors see them online unless they switched to invisible
///   (`force_offline`) or are outside their schedule (`/api/availability`);</item>
/// <item>teammates see active / away / disconnected / offline, from being
///   subscribed to the operators channel (InboxRealtime joins it) and from a
///   heartbeat every two minutes that says whether they touched the app.</item>
/// </list>
/// Runs on the UI thread; raises <see cref="Changed"/> after anything moves.
/// </summary>
public sealed class PresenceService : IDisposable
{
    private static readonly TimeSpan HeartbeatEvery = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan TeamEvery = TimeSpan.FromSeconds(10);

    private readonly AppHost _host;
    private readonly string _workspaceId;
    private Poller? _heartbeat;
    private Poller? _team;
    private bool _interacted = true;

    public PresenceService(AppHost host, string workspaceId)
    {
        _host = host;
        _workspaceId = workspaceId;
    }

    public event Action? Changed;

    /// <summary>What visitors see, from the server's own rules.</summary>
    public Availability? Availability { get; private set; }

    /// <summary>What teammates see: active, away, disconnected or offline.</summary>
    public string State { get; private set; } = PresenceStates.Offline;

    /// <summary>Everyone's state by user id, for colleague and assignee avatars.</summary>
    public IReadOnlyDictionary<string, TeamPresence> Team { get; private set; } = new Dictionary<string, TeamPresence>();

    public bool IsInvisible => Availability?.Prefs.ForceOffline == true;

    public void Start()
    {
        _heartbeat = new Poller("heartbeat", BeatAsync, () => HeartbeatEvery);
        _heartbeat.Start();
        _team = new Poller("team presence", RefreshAsync, () => TeamEvery);
        _team.Start();
        if (_host.Realtime is { } rt) rt.PresenceJoined += () => _host.RunOnUi(() => _team?.Kick());
    }

    /// <summary>A key, a click or the window coming forward: the operator is at the desk.</summary>
    public void NoteInteraction() => _interacted = true;

    public async Task SetInvisibleAsync(bool invisible)
    {
        Availability = await _host.Api.SetForceOfflineAsync(invisible);
        Changed?.Invoke();
        _team?.Kick();
    }

    private async Task BeatAsync(CancellationToken ct)
    {
        var interacted = _interacted;
        _interacted = false;
        await _host.Api.HeartbeatAsync(_workspaceId, interacted, ct);
    }

    private async Task RefreshAsync(CancellationToken ct)
    {
        var locale = _host.Strings.Language switch { Language.Fa => "fa", Language.Tr => "tr", _ => "en" };
        try
        {
            Availability = await _host.Api.AvailabilityAsync(locale, ct);
        }
        catch (ApiException e) when (e.Failure is not ApiFailure.Transport and not ApiFailure.Unauthorized)
        {
            Log.Error("availability", e);
        }
        var team = await _host.Api.TeamPresenceAsync(_workspaceId, ct);
        Team = team.GroupBy(p => p.UserId).ToDictionary(g => g.Key, g => g.First());
        var me = _host.User?.Id is { } id && Team.TryGetValue(id, out var p) ? p : null;
        State = me?.Effective ?? (Availability?.Status.IsOnline == true ? PresenceStates.Active : PresenceStates.Offline);
        Changed?.Invoke();
    }

    public void Dispose()
    {
        _heartbeat?.Dispose();
        _team?.Dispose();
    }
}
