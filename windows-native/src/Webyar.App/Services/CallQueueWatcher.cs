using Webyar.App.Helpers;
using Webyar.Core.Api;

namespace Webyar.App.Services;

/// <summary>
/// Keeps an eye on the call center's waiting line while the app runs, so a
/// call is never missed on another page: the sidebar badge, the web desk's
/// chime, and a toast when the window is not in front.
/// </summary>
public sealed class CallQueueWatcher : IDisposable
{
    private readonly AppHost _host;
    private readonly string _workspaceId;
    private readonly HashSet<string> _known = [];
    private Poller? _poller;
    private bool _primed;
    private bool _disabled;

    public CallQueueWatcher(AppHost host, string workspaceId)
    {
        _host = host;
        _workspaceId = workspaceId;
    }

    /// <summary>The waiting line, newest poll; the call center page reads it too.</summary>
    public IReadOnlyList<QueueEntry> Queue { get; private set; } = [];

    public event Action? Changed;

    public void Start()
    {
        _poller = new Poller("call queue", PollAsync, () => _host.PollInterval(TimeSpan.FromSeconds(6)));
        _poller.Start();
    }

    public void Kick() => _poller?.Kick();

    private async Task PollAsync(CancellationToken ct)
    {
        if (_disabled) return;
        IReadOnlyList<QueueEntry> queue;
        try
        {
            queue = await _host.Api.CallQueueAsync(_workspaceId, ct);
        }
        catch (ApiException e) when (e.Status is 403 or 404)
        {
            // No call center on this plan or for this role: stop asking.
            _disabled = true;
            Queue = [];
            Changed?.Invoke();
            return;
        }
        var fresh = queue.Where(q => !_known.Contains(q.CallSessionId)).ToList();
        _known.IntersectWith(queue.Select(q => q.CallSessionId));
        foreach (var q in queue) _known.Add(q.CallSessionId);
        Queue = queue;
        Changed?.Invoke();
        // The first poll only learns what is already waiting, as the web desk does.
        if (_primed && fresh.Count > 0) Announce(fresh[0]);
        _primed = true;
    }

    private void Announce(QueueEntry entry)
    {
        if (_host.Settings.NotificationSound) Chime.Play();
        if (!_host.Settings.Notifications || App.Current.Window?.IsForeground == true) return;
        var s = _host.Strings;
        var name = CallNames.Caller(entry, s);
        _host.Notifier.Show(s["incomingCallTitle"], s.Get("incomingCallBody", "name", name), s.IsRightToLeft, silent: true,
            new Dictionary<string, string> { ["page"] = "calls", ["call"] = entry.CallSessionId });
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
