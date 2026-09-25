using System.Collections.ObjectModel;
using System.Net;
using System.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;

namespace Webyar.App.Views;

/// <summary>
/// The workspace mailbox (the web console's email inbox): threads on the left,
/// the open thread on the right with a reply box. Mail HTML is shown in a
/// WebView2 with scripts off, so a message can look like itself but not act.
/// </summary>
public sealed partial class EmailPage : Page
{
    private readonly ObservableCollection<EmailThreadItem> _items = [];
    private EmailThreadDetail? _open;
    private string? _search;
    private bool _webReady;

    public EmailPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
    }

    private static AppHost Host => App.Current.Host;

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        var s = Host.Strings;
        HeaderText.Text = s["emailInbox"];
        ComposeText.Text = s["newEmail"];
        Search.PlaceholderText = s["emailSearch"];
        PlaceholderTitle.Text = s["noEmailSelected"];
        PlaceholderBody.Text = s["noEmailSelectedBody"];
        ReplyBox.PlaceholderText = s["emailReplyPlaceholder"];
        ReplyButton.Content = s["emailReply"];
        ToolTipService.SetToolTip(StarButton, s["emailStar"]);
        ToolTipService.SetToolTip(UnreadButton, s["emailMarkUnread"]);
        await LoadAsync();
    }

    private async Task LoadAsync()
    {
        if (Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        Loading.Visibility = Visibility.Visible;
        Loading.IsActive = true;
        try
        {
            var connection = await Host.Api.GmailConnectionAsync(ws.Id);
            var threads = await Host.Api.EmailThreadsAsync(ws.Id, _search);
            _items.Clear();
            foreach (var t in threads.OrderByDescending(t => t.LastMessageAt ?? DateTimeOffset.MinValue)) _items.Add(new EmailThreadItem(t, s));
            if (_items.Count == 0)
            {
                var connected = connection?.Connected == true;
                EmptyTitle.Text = connected || _search is not null ? s["emailEmptyTitle"] : s["emailNotConnectedTitle"];
                EmptyBody.Text = connected || _search is not null ? s["emailEmptyBody"] : s["emailNotConnectedBody"];
            }
            Empty.Visibility = _items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (Exception e)
        {
            Log.Error("email threads", e);
            EmptyTitle.Text = ErrorText.For(e, s);
            EmptyBody.Text = string.Empty;
            Empty.Visibility = Visibility.Visible;
        }
        finally
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
        }
    }

    private async void OnSearch(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args)
    {
        _search = string.IsNullOrWhiteSpace(sender.Text) ? null : sender.Text.Trim();
        await LoadAsync();
    }

    private async void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (List.SelectedItem is not EmailThreadItem item || Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        Placeholder.Visibility = Visibility.Collapsed;
        ThreadView.Visibility = Visibility.Visible;
        SubjectText.Text = item.Subject;
        StarButton.IsChecked = item.Thread.IsStarred == true;
        ReplyStatus.Text = string.Empty;
        try
        {
            _open = await Host.Api.EmailThreadAsync(ws.Id, item.Id);
            if (!ReferenceEquals(List.SelectedItem, item)) return;
            await RenderAsync(_open);
            if (item.Thread.IsRead == false)
            {
                await Host.Api.SetEmailReadAsync(ws.Id, item.Id, true);
                item.Update(item.Thread with { IsRead = true }, s);
            }
        }
        catch (Exception ex)
        {
            Log.Error("email thread", ex);
            ReplyStatus.Text = ErrorText.For(ex, s);
        }
    }

    private async Task RenderAsync(EmailThreadDetail detail)
    {
        if (!_webReady)
        {
            await Body.EnsureCoreWebView2Async();
            Body.CoreWebView2.Settings.IsScriptEnabled = false;
            Body.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            Body.CoreWebView2.Settings.AreDevToolsEnabled = false;
            // Links open in the browser, never inside the app.
            Body.CoreWebView2.NewWindowRequested += (w, a) =>
            {
                a.Handled = true;
                if (Uri.TryCreate(a.Uri, UriKind.Absolute, out var u) && u.Scheme is "https" or "http" or "mailto") _ = Windows.System.Launcher.LaunchUriAsync(u);
            };
            Body.CoreWebView2.NavigationStarting += (w, a) =>
            {
                if (a.Uri.StartsWith("data:", StringComparison.Ordinal) || a.Uri == "about:blank") return;
                a.Cancel = true;
                if (Uri.TryCreate(a.Uri, UriKind.Absolute, out var u) && u.Scheme is "https" or "http" or "mailto") _ = Windows.System.Launcher.LaunchUriAsync(u);
            };
            _webReady = true;
        }
        Body.NavigateToString(Html(detail));
    }

    /// <summary>The thread as one page: each message a card, HTML bodies as sent, text bodies escaped.</summary>
    private string Html(EmailThreadDetail detail)
    {
        var s = Host.Strings;
        var dark = ActualTheme == ElementTheme.Dark;
        var dir = s.IsRightToLeft ? "rtl" : "ltr";
        var sb = new StringBuilder();
        sb.Append($"<!doctype html><html dir=\"{dir}\"><head><meta charset=\"utf-8\"><style>")
          .Append("body{margin:0;padding:16px 18px;font-family:'Segoe UI Variable Text','Segoe UI',Tahoma,sans-serif;font-size:14px;")
          .Append(dark ? "background:#13161e;color:#e8ecf4;}" : "background:#ffffff;color:#0f1729;}")
          .Append(".m{border:1px solid ").Append(dark ? "#242a36" : "#e3e7ee").Append(";border-radius:12px;padding:14px 16px;margin-bottom:14px;}")
          .Append(".h{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px;font-size:12.5px;color:").Append(dark ? "#98a2b3" : "#5b6577").Append(";}")
          .Append(".f{font-weight:600;color:").Append(dark ? "#e8ecf4" : "#0f1729").Append(";font-size:13.5px}")
          .Append(".b{overflow-wrap:anywhere} .b img{max-width:100%;height:auto} pre{white-space:pre-wrap;font-family:inherit;margin:0}")
          .Append(".err{color:#e5484d;font-size:12px;margin-top:8px}")
          .Append("</style></head><body>");
        foreach (var m in (detail.Messages ?? []).OrderBy(m => m.SentAt ?? DateTimeOffset.MinValue))
        {
            var when = m.SentAt is { } at ? $"{Display.ShortDate(at.ToLocalTime().Date, s.Language)} {Display.ClockTime(at, s.Language)}" : string.Empty;
            var to = string.Join(", ", (m.ToAddresses ?? []).Select(a => a.Email));
            sb.Append("<div class=\"m\"><div class=\"h\"><div><div class=\"f\">").Append(WebUtility.HtmlEncode(m.FromAddress ?? string.Empty))
              .Append("</div><div>").Append(WebUtility.HtmlEncode($"{s["emailTo"]}: {to}")).Append("</div></div><div>")
              .Append(WebUtility.HtmlEncode(when)).Append("</div></div><div class=\"b\">");
            if (!string.IsNullOrWhiteSpace(m.HtmlBody)) sb.Append(m.HtmlBody);
            else sb.Append("<pre>").Append(WebUtility.HtmlEncode(m.TextBody ?? m.Snippet ?? string.Empty)).Append("</pre>");
            sb.Append("</div>");
            if (!string.IsNullOrWhiteSpace(m.DeliveryError)) sb.Append("<div class=\"err\">").Append(WebUtility.HtmlEncode(m.DeliveryError)).Append("</div>");
            sb.Append("</div>");
        }
        sb.Append("</body></html>");
        return sb.ToString();
    }

    private async void OnReply(object sender, RoutedEventArgs e)
    {
        var body = ReplyBox.Text.Trim();
        if (body.Length == 0 || _open?.Thread is not { } thread || Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        var me = Host.User?.Email;
        var to = (thread.Participants ?? []).Select(p => p.Email).Where(a => !string.Equals(a, me, StringComparison.OrdinalIgnoreCase)).Distinct().ToList();
        if (to.Count == 0 && (_open.Messages ?? []).LastOrDefault(m => m.Direction != "outbound")?.FromAddress is { } from) to.Add(from);
        var subject = thread.Subject is { Length: > 0 } sub ? (sub.StartsWith("Re:", StringComparison.OrdinalIgnoreCase) ? sub : "Re: " + sub) : "Re:";
        ReplyButton.IsEnabled = false;
        try
        {
            await Host.Api.SendEmailAsync(ws.Id, thread.Id, to, subject, body);
            ReplyBox.Text = string.Empty;
            ReplyStatus.Text = s["emailSent"];
            _open = await Host.Api.EmailThreadAsync(ws.Id, thread.Id);
            await RenderAsync(_open);
        }
        catch (Exception ex)
        {
            Log.Error("email reply", ex);
            ReplyStatus.Text = $"{s["emailSendFailed"]} — {ErrorText.For(ex, s)}";
        }
        finally
        {
            ReplyButton.IsEnabled = true;
        }
    }

    private async void OnStar(object sender, RoutedEventArgs e)
    {
        if (List.SelectedItem is not EmailThreadItem item || Host.Workspace is not { } ws) return;
        var starred = StarButton.IsChecked == true;
        try
        {
            await Host.Api.SetEmailStarredAsync(ws.Id, item.Id, starred);
            item.Update(item.Thread with { IsStarred = starred }, Host.Strings);
        }
        catch (Exception ex)
        {
            Log.Error("email star", ex);
            StarButton.IsChecked = !starred;
        }
    }

    private async void OnMarkUnread(object sender, RoutedEventArgs e)
    {
        if (List.SelectedItem is not EmailThreadItem item || Host.Workspace is not { } ws) return;
        try
        {
            await Host.Api.SetEmailReadAsync(ws.Id, item.Id, false);
            item.Update(item.Thread with { IsRead = false }, Host.Strings);
            List.SelectedItem = null;
            ThreadView.Visibility = Visibility.Collapsed;
            Placeholder.Visibility = Visibility.Visible;
        }
        catch (Exception ex)
        {
            Log.Error("email unread", ex);
        }
    }

    private async void OnCompose(object sender, RoutedEventArgs e)
    {
        if (Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        var to = new TextBox { Header = s["emailTo"], FlowDirection = FlowDirection.LeftToRight, InputScope = new Microsoft.UI.Xaml.Input.InputScope { Names = { new Microsoft.UI.Xaml.Input.InputScopeName(Microsoft.UI.Xaml.Input.InputScopeNameValue.EmailSmtpAddress) } } };
        var subject = new TextBox { Header = s["emailSubject"] };
        var body = new TextBox { PlaceholderText = s["emailReplyPlaceholder"], AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 160 };
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            FlowDirection = FlowDirection,
            Title = s["newEmail"],
            Content = new StackPanel { Spacing = 10, Width = 460, Children = { to, subject, body } },
            PrimaryButtonText = s["emailSend"],
            CloseButtonText = s["cancel"],
            DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        var recipients = to.Text.Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        if (recipients.Count == 0 || body.Text.Trim().Length == 0) return;
        try
        {
            await Host.Api.SendEmailAsync(ws.Id, null, recipients, subject.Text.Trim(), body.Text.Trim());
            await LoadAsync();
        }
        catch (Exception ex)
        {
            Log.Error("email send", ex);
            await new ContentDialog { XamlRoot = XamlRoot, FlowDirection = FlowDirection, Title = s["emailSendFailed"], Content = ErrorText.For(ex, s), CloseButtonText = s["ok"] }.ShowAsync();
        }
    }
}
