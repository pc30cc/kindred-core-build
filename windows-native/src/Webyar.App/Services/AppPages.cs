using Microsoft.Web.WebView2.Core;
using Windows.System;

namespace Webyar.App.Services;

/// <summary>
/// The app's own pages in a WebView2 (the call's media page, the visitors'
/// map): served from the install's Assets folder under one virtual https host,
/// and fenced so nothing else gets what is meant for them. Only that host may
/// be the page, use the microphone or camera, or talk to the app; a link the
/// operator clicks opens in the browser, and nothing navigates on its own.
/// </summary>
internal static class AppPages
{
    /// <summary>The virtual host Assets is served under (a real https origin: getUserMedia needs a secure context).</summary>
    public const string Host = "webyar.app";

    public const string Origin = "https://" + Host;

    public static bool IsOwn(string? uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u)
        && u.Scheme == Uri.UriSchemeHttps
        && string.Equals(u.Host, Host, StringComparison.OrdinalIgnoreCase)
        && u.IsDefaultPort;

    /// <summary>
    /// Maps Assets, and fences the view: <paramref name="allowed"/> are the
    /// permissions the app's own page is granted; every other request, and
    /// every request from anywhere else, is denied.
    /// </summary>
    public static void Serve(CoreWebView2 core, params CoreWebView2PermissionKind[] allowed)
    {
        core.SetVirtualHostNameToFolderMapping(Host, Path.Combine(AppContext.BaseDirectory, "Assets"), CoreWebView2HostResourceAccessKind.Allow);
        core.PermissionRequested += (_, e) =>
        {
            e.State = IsOwn(e.Uri) && Array.IndexOf(allowed, e.PermissionKind) >= 0
                ? CoreWebView2PermissionState.Allow
                : CoreWebView2PermissionState.Deny;
        };
        core.NavigationStarting += (_, e) =>
        {
            if (IsOwn(e.Uri)) return;
            e.Cancel = true;
            OpenClicked(e.Uri, e.IsUserInitiated);
        };
        core.FrameNavigationStarting += (_, e) =>
        {
            if (!IsOwn(e.Uri)) e.Cancel = true;
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenClicked(e.Uri, e.IsUserInitiated);
        };
    }

    /// <summary>A message from the page, only when the page is the app's own.</summary>
    public static bool FromOwnPage(CoreWebView2WebMessageReceivedEventArgs e) => IsOwn(e.Source);

    private static void OpenClicked(string uri, bool userInitiated)
    {
        if (!userInitiated) return;
        if (Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp))
            _ = Launcher.LaunchUriAsync(u);
    }
}
