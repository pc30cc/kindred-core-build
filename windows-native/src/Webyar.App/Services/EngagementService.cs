using Webyar.Core.Api;
using Webyar.Core.Localization;

namespace Webyar.App.Services;

/// <summary>
/// What Super Admin shows the Windows app: ads and announcements for the
/// workspace's plan (refreshed every few minutes), and the heartbeat that
/// counts this copy as running and brings broadcasts back. Pages ask
/// <see cref="AdFor"/> for their placement and redraw on <see cref="Changed"/>.
/// </summary>
public sealed class EngagementService : IDisposable
{
    private static readonly TimeSpan CampaignsEvery = TimeSpan.FromMinutes(5);
    private readonly AppHost _host;
    private readonly string _sessionId = Guid.NewGuid().ToString("N");
    private readonly CancellationTokenSource _stop = new();
    private IReadOnlyList<DesktopCampaign> _campaigns = [];
    private bool _started;

    public EngagementService(AppHost host) => _host = host;

    /// <summary>Raised on the UI thread when the set of campaigns changes.</summary>
    public event Action? Changed;

    /// <summary>A Super Admin broadcast just arrived (UI thread).</summary>
    public event Action<DesktopBroadcast>? Broadcast;

    public void Start()
    {
        if (_started) return;
        _started = true;
        _ = CampaignLoopAsync(_stop.Token);
        _ = HeartbeatLoopAsync(_stop.Token);
    }

    /// <summary>A new workspace or language: fetch again at once.</summary>
    public void Refresh() => _ = LoadCampaignsAsync(_stop.Token);

    public IReadOnlyList<DesktopCampaign> Announcements =>
        _campaigns.Where(c => c.IsAnnouncement && !Dismissed(c)).ToList();

    /// <summary>The ad for a placement (inbox_list, colleagues_list, contacts_list, chat_empty, settings), or null.</summary>
    public DesktopCampaign? AdFor(string placement) =>
        _campaigns.Where(c => !c.IsAnnouncement && c.Shows(placement) && !Dismissed(c))
            .OrderByDescending(c => c.Priority)
            .FirstOrDefault();

    public void Dismiss(DesktopCampaign c)
    {
        if (!c.Dismissible) return;
        var list = _host.Settings.DismissedCampaigns;
        if (!list.Contains(c.Id)) list.Add(c.Id);
        // Keep the file small: only ids still on offer matter.
        if (list.Count > 200) list.RemoveRange(0, list.Count - 200);
        _host.Settings.Save();
        Changed?.Invoke();
    }

    private bool Dismissed(DesktopCampaign c) => c.Dismissible && _host.Settings.DismissedCampaigns.Contains(c.Id);

    private async Task CampaignLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await LoadCampaignsAsync(ct);
            try { await Task.Delay(CampaignsEvery, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task LoadCampaignsAsync(CancellationToken ct)
    {
        if (_host.Workspace is not { } ws || _host.User is null)
        {
            Set([]);
            return;
        }
        var list = await _host.Api.DesktopCampaignsAsync(ws.Id, Strings.Code(_host.Strings.Language), ct);
        Set(list);
    }

    private void Set(IReadOnlyList<DesktopCampaign> list)
    {
        var same = list.Count == _campaigns.Count && list.Select(c => c.Id + c.Title + c.Body).SequenceEqual(_campaigns.Select(c => c.Id + c.Title + c.Body));
        _campaigns = list;
        if (!same) _host.RunOnUi(() => Changed?.Invoke());
    }

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        var interval = TimeSpan.FromSeconds(45);
        while (!ct.IsCancellationRequested)
        {
            if (_host.User is not null)
            {
                try
                {
                    var seq = _host.Settings.LastBroadcastSeq;
                    var beat = await _host.Api.DesktopHeartbeatAsync(_sessionId, _host.Workspace?.Id, _host.Updates.CurrentVersion, seq, ct);
                    if (beat.IntervalSeconds is > 10 and < 600) interval = TimeSpan.FromSeconds(beat.IntervalSeconds.Value);
                    var fresh = (beat.Broadcasts ?? []).OrderBy(b => b.Seq).ToList();
                    var latest = fresh.Count > 0 ? fresh[^1].Seq : beat.LatestSeq;
                    if (latest is not null && latest != seq)
                    {
                        _host.Settings.LastBroadcastSeq = latest;
                        _host.Settings.Save();
                    }
                    // The first check-in only learns where the queue stands (seq was null): no replay.
                    if (seq is not null)
                        foreach (var b in fresh) _host.RunOnUi(() => Broadcast?.Invoke(b));
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception e)
                {
                    if (e is not ApiException { Failure: ApiFailure.Transport }) Log.Error("heartbeat", e);
                }
            }
            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        try
        {
            // Best effort: counted out at once instead of after the timeout.
            if (_host.User is not null) _host.Api.DesktopGoodbyeAsync(_sessionId).Wait(TimeSpan.FromSeconds(2));
        }
        catch
        {
        }
    }
}
