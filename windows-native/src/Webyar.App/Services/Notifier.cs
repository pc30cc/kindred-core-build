using System.Security;
using Microsoft.Windows.AppNotifications;

namespace Webyar.App.Services;

/// <summary>
/// Native Windows toasts through the Windows App SDK. A Persian toast is laid
/// out right to left by hand — Windows 10 keeps toast text left-aligned and
/// pins the app logo to the left whatever the language — using the adaptive
/// layout tested on a real Windows 10 machine: title and body in a
/// right-aligned group, the logo in a column on its right, and a lone RLM as
/// the header line so Windows prints no "New notification" placeholder.
/// </summary>
public sealed class Notifier : IDisposable
{
    private bool _registered;

    /// <summary>Raised on a background thread with the arguments the toast was created with.</summary>
    public event Action<IReadOnlyDictionary<string, string>>? Invoked;

    public void Register()
    {
        if (_registered) return;
        try
        {
            AppNotificationManager.Default.NotificationInvoked += OnInvoked;
            AppNotificationManager.Default.Register();
            _registered = true;
        }
        catch (Exception e)
        {
            Log.Error("register notifications", e);
        }
    }

    private void OnInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args) =>
        Invoked?.Invoke(ParseLaunch(args.Argument));

    /// <summary>Our own `a=1&amp;b=2` launch string, parsed by hand so it cannot drift with the SDK's format.</summary>
    public static IReadOnlyDictionary<string, string> ParseLaunch(string? launch)
    {
        var result = new Dictionary<string, string>();
        foreach (var part in (launch ?? string.Empty).Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            result[Uri.UnescapeDataString(part[..eq])] = Uri.UnescapeDataString(part[(eq + 1)..]);
        }
        return result;
    }

    /// <summary>Handles a launch that came from clicking a toast while the app was not running.</summary>
    public static IReadOnlyDictionary<string, string>? LaunchArguments()
    {
        try
        {
            var activated = Microsoft.Windows.AppLifecycle.AppInstance.GetCurrent().GetActivatedEventArgs();
            if (activated.Kind == Microsoft.Windows.AppLifecycle.ExtendedActivationKind.AppNotification &&
                activated.Data is AppNotificationActivatedEventArgs toast)
                return ParseLaunch(toast.Argument);
        }
        catch (Exception e)
        {
            Log.Error("toast launch args", e);
        }
        return null;
    }

    public void Show(string title, string body, bool rtl, bool silent, IReadOnlyDictionary<string, string> arguments)
    {
        if (!_registered) return;
        try
        {
            var launch = string.Join("&", arguments.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
            var xml = rtl ? RightToLeft(title, body, launch, silent) : LeftToRight(title, body, launch, silent);
            AppNotificationManager.Default.Show(new AppNotification(xml));
        }
        catch (Exception e)
        {
            Log.Error("show notification", e);
        }
    }

    private static string E(string s) => SecurityElement.Escape(s) ?? string.Empty;

    private static string Icon => E(new Uri(AppPaths.Icon).AbsoluteUri);

    private static string Audio(bool silent) => silent ? "<audio silent=\"true\"/>" : string.Empty;

    internal static string LeftToRight(string title, string body, string launch, bool silent) =>
        $"<toast launch=\"{E(launch)}\"><visual><binding template=\"ToastGeneric\">" +
        $"<text>{E(title)}</text><text>{E(body)}</text>" +
        $"<image placement=\"appLogoOverride\" src=\"{Icon}\"/>" +
        $"</binding></visual>{Audio(silent)}</toast>";

    internal static string RightToLeft(string title, string body, string launch, bool silent) =>
        $"<toast launch=\"{E(launch)}\"><visual><binding template=\"ToastGeneric\">" +
        "<text>&#x200F;</text>" +
        "<group><subgroup hint-weight=\"80\">" +
        $"<text hint-style=\"base\" hint-align=\"right\">{E(title)}</text>" +
        $"<text hint-style=\"bodySubtle\" hint-align=\"right\" hint-wrap=\"true\" hint-maxLines=\"3\">{E(body)}</text>" +
        "</subgroup>" +
        $"<subgroup hint-weight=\"20\" hint-textStacking=\"center\"><image src=\"{Icon}\" hint-removeMargin=\"true\"/></subgroup>" +
        "</group></binding></visual>" +
        $"{Audio(silent)}</toast>";

    public void Dispose()
    {
        if (!_registered) return;
        try
        {
            AppNotificationManager.Default.Unregister();
        }
        catch (Exception e)
        {
            Log.Error("unregister notifications", e);
        }
    }
}
