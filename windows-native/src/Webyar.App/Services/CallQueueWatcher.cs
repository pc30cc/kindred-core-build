using Webyar.App.Helpers;
using Webyar.Core.Api;

namespace Webyar.App.Services;

/// <summary>
/// Keeps an eye on the call center's waiting line while the app runs, so a
/// call is never missed on another page: the sidebar badge, the in-app
/// ringing banner with the web desk's chime, and a toast when the window is
/// not in front. Realtime carries no call-center events to the app, so this
/// polls at the web desk's own pace whether or not realtime is connected.
/// </summary>
public sealed class CallQueueWatcher : IDisposable
{
    private readonly AppHost _host;
    private readonly string _workspaceId;
    private readonly HashSet<string> _known = [];
    private Poller? _poller;
    private bool _primed;
    private bool _disabled;
    private int _polls;

    public CallQueueWatcher(AppHost host, string workspaceId)
    {
        _host = host;
        _workspaceId = workspaceId;
    }

    /// <summary>The waiting line, newest poll; the call center page reads it too.</summary>
    public IReadOnlyList<QueueEntry> Queue { get; private set; } = [];

    public event Action? Changed;

    /// <summary>Raised on the UI thread for each call that newly joins the line.</summary>
    public event Action<QueueEntry>? Ringing;

    /// <summary>
    /// Raised on the UI thread with the calls under way, every other poll: one a
    /// colleague handed to this operator left the line long ago, so the line
    /// alone never shows it.
    /// </summary>
    public event Action<IReadOnlyList<CallSession>>? ActiveCalls;

    /// <summary>The web desk refetches the queue every 5 s; a ring lasts at most 45 s.</summary>
    private static readonly TimeSpan Every = TimeSpan.FromSeconds(4);

    public void Start()
    {
        _poller = new Poller("call queue", PollAsync, () => Every);
        _poller.Start();
    }

    public void Kick() => _poller?.Kick();

    private async Task PollAsync(CancellationToken ct)
    {
        if (_disabled) return;
        // The desk is off (the plan still loading or unreadable, or the platform
        // switched calls off): nothing waits, and whatever is waiting when it
        // comes back is learnt, not rung.
        if (!_host.Plan.CallCenter)
        {
            _known.Clear();
            _primed = false;
            if (Queue.Count > 0)
            {
                Queue = [];
                Changed?.Invoke();
            }
            return;
        }
        IReadOnlyList<QueueEntry> queue;
        try
        {
            queue = await _host.Api.CallQueueAsync(_workspaceId, ct);
        }
        catch (ApiException e) when (e.Status is 403 or 404)
        {
            // No call center on this plan or for this role: stop asking.
            Log.Write($"[calls] queue unavailable ({e.Status}), watcher off");
            _disabled = true;
            Queue = [];
            Changed?.Invoke();
            return;
        }
        _polls++;
        if (_polls % 2 == 1 && ActiveCalls is not null)
        {
            // Best-effort: the line is what matters here, so a failure is only logged.
            try
            {
                ActiveCalls?.Invoke(await _host.Api.ActiveCallsAsync(_workspaceId, ct));
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                if (e is not ApiException { Failure: ApiFailure.Transport }) Log.Error("active calls", e);
            }
        }
        var fresh = queue.Where(q => !_known.Contains(q.CallSessionId)).ToList();
        _known.IntersectWith(queue.Select(q => q.CallSessionId));
        foreach (var q in queue) _known.Add(q.CallSessionId);
        Queue = queue;
        Changed?.Invoke();
        // The first poll only learns what is already waiting, as the web desk does.
        if (_primed)
        {
            foreach (var f in fresh)
            {
                Log.Write($"[calls] ringing {f.CallSessionId}");
                Ringing?.Invoke(f);
            }
            if (fresh.Count > 0) Announce(fresh[0]);
        }
        else
        {
            Log.Write($"[calls] watching queue, {queue.Count} waiting");
        }
        _primed = true;
    }

    private void Announce(QueueEntry entry)
    {
        if (!_host.Settings.Notifications || App.Current.Window?.IsForeground == true) return;
        var s = _host.Strings;
        var name = CallNames.Caller(entry, s);
        _host.Notifier.Show(s["incomingCallTitle"], s.Get("incomingCallBody", "name", name), s.IsRightToLeft, silent: true,
            new Dictionary<string, string> { ["page"] = "calls", ["call"] = entry.CallSessionId, ["workspace"] = _workspaceId });
    }

    public void Dispose() => _poller?.Dispose();
}

/// <summary>How the desk names a caller: their name, email or phone, else "Visitor · code".</summary>
public static class CallNames
{
    public static string Caller(QueueEntry q, Webyar.Core.Localization.Strings s) => Caller(q.CallSession, q.ContactId ?? q.VisitorSessionId ?? q.CallSessionId, s);

    public static string Caller(CallSession? c, string? fallbackId, Webyar.Core.Localization.Strings s) =>
        c?.VisitorName is { Length: > 0 } n ? n
        : c?.VisitorEmail is { Length: > 0 } e ? e
        : c?.VisitorPhone is { Length: > 0 } p ? p
        : Webyar.Core.Inbox.Display.VisitorName(null, null, fallbackId, null, null, null, s);
}
