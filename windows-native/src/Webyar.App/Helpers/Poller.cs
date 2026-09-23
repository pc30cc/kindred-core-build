using Webyar.App.Services;
using Webyar.Core.Api;

namespace Webyar.App.Helpers;

/// <summary>
/// Runs a piece of work now and then again after an interval, on the thread
/// that started it (the UI thread). <see cref="Kick"/> runs it at once, e.g.
/// when a realtime event says something changed; a kick that lands mid-run
/// makes it run once more straight after, so no change is missed.
/// </summary>
public sealed class Poller : IDisposable
{
    private readonly Func<CancellationToken, Task> _work;
    private readonly Func<TimeSpan> _interval;
    private readonly string _name;
    private readonly CancellationTokenSource _stop = new();
    private CancellationTokenSource _wake = new();
    private bool _started;

    public Poller(string name, Func<CancellationToken, Task> work, Func<TimeSpan> interval)
    {
        _name = name;
        _work = work;
        _interval = interval;
    }

    public void Start()
    {
        if (_started || _stop.IsCancellationRequested) return;
        _started = true;
        _ = LoopAsync();
    }

    public void Kick()
    {
        if (!_stop.IsCancellationRequested) _wake.Cancel();
    }

    private async Task LoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                await _work(_stop.Token);
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
                return;
            }
            catch (ApiException e) when (e.Failure == ApiFailure.Transport)
            {
                // Offline: the next tick tries again; nothing to log every few seconds.
            }
            catch (Exception e)
            {
                Log.Error($"poll {_name}", e);
            }

            if (!_wake.IsCancellationRequested)
            {
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token, _wake.Token);
                try
                {
                    await Task.Delay(_interval(), linked.Token);
                }
                catch (OperationCanceledException)
                {
                }
            }
            if (_wake.IsCancellationRequested)
            {
                _wake.Dispose();
                _wake = new CancellationTokenSource();
            }
        }
    }

    public void Dispose() => _stop.Cancel();
}
