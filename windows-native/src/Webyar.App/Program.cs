using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Velopack;

namespace Webyar.App;

public static class Program
{
    /// <summary>Signalled by a second launch so the running copy comes to the front instead.</summary>
    internal const string ActivateEventName = "Webyar.Windows.Activate";
    private const string MutexName = "Webyar.Windows.SingleInstance";

    [STAThread]
    public static int Main(string[] args)
    {
        // Velopack's install, update and uninstall hooks run before anything else, then return.
        VelopackApp.Build().Run();

        using var mutex = new Mutex(initiallyOwned: true, MutexName, out var first);
        if (!first)
        {
            // One running copy: a shortcut or the Start menu brings the first one forward.
            try
            {
                using var activate = EventWaitHandle.OpenExisting(ActivateEventName);
                activate.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
            }
            return 0;
        }

        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(_ =>
        {
            var context = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(context);
            _ = new App(startHidden: args.Contains("--hidden"));
        });
        return 0;
    }
}
