using System.Collections.ObjectModel;
using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Controls;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.Views;

/// <summary>
/// Everyone who has talked to the workspace, searchable, and each one as a
/// profile — the web's contact page: details, their conversations, their
/// calls, notes and tags.
/// </summary>
public sealed partial class ContactsPage : Page
{
    private readonly ObservableCollection<ContactItem> _items = [];
    private List<ContactItem> _all = [];
    private ContactItem? _shown;
    private IReadOnlyList<ContactConversation> _chats = [];
    private CancellationTokenSource? _detail;

    public ContactsPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
    }

    private static AppHost Host => App.Current.Host;

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        var s = Host.Strings;
        HeaderText.Text = s["tabContacts"];
        Search.PlaceholderText = s["contactsSearch"];
        EmptyTitle.Text = s["contactsEmptyTitle"];
        EmptyBody.Text = s["contactsEmptyBody"];
        PlaceholderTitle.Text = s["noContactSelected"];
        TabOverview.Text = s["contactOverview"];
        TabChats.Text = s["contactConversations"];
        TabCalls.Text = s["contactCalls"];
        TabNotes.Text = s["contactNotes"];
        EmailButtonText.Text = s["contactSendEmail"];
        OpenChatText.Text = s["ccOpenConversation"];
        StatChatsLabel.Text = s["contactConversations"];
        StatCallsLabel.Text = s["contactCalls"];
        StatFirstLabel.Text = s["firstSeen"];
        StatUpdatedLabel.Text = s["contactUpdated"];
        TagsLabel.Text = s["tags"];
        if (Host.Workspace is not { } ws) return;
        try
        {
            var contacts = await Host.Api.ContactsAsync(ws.Id);
            // Like the web table, rows wait for the network profiles, so the
            // avatars appear once, with the OS and flag, instead of changing.
            var profiles = await Host.Api.ContactProfilesAsync(ws.Id, contacts.Select(c => c.Id).ToList());
            _all = contacts
                .Select(c => new ContactItem(c, profiles.GetValueOrDefault(c.Id), s))
                .OrderByDescending(c => c.Contact.UpdatedAt ?? c.Contact.CreatedAt ?? DateTimeOffset.MinValue)
                .ToList();
            CountText.Text = Digits.Localize(_all.Count.ToString(CultureInfo.InvariantCulture), s.Language);
            Filter();
            // Webyar.exe --page=contacts --contact=<id> opens straight on that profile.
            var wanted = Environment.GetCommandLineArgs().FirstOrDefault(a => a.StartsWith("--contact=", StringComparison.Ordinal))?[10..];
            if (wanted is not null && _items.FirstOrDefault(c => c.Id == wanted) is { } hit) List.SelectedItem = hit;
        }
        catch (Exception ex)
        {
            Log.Error("contacts", ex);
            EmptyTitle.Text = ErrorText.For(ex, s);
            EmptyBody.Text = string.Empty;
            Empty.Visibility = Visibility.Visible;
        }
        finally
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
        }
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        _detail?.Cancel();
    }

    private void Filter()
    {
        var q = Search.Text.Trim();
        _items.Clear();
        foreach (var c in _all.Where(c => c.Matches(q)).Take(500)) _items.Add(c);
        Empty.Visibility = _items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnSearch(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args) => Filter();

    private async void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (List.SelectedItem is not ContactItem c) return;
        _shown = c;
        _detail?.Cancel();
        _detail = new CancellationTokenSource();
        var ct = _detail.Token;
        Placeholder.Visibility = Visibility.Collapsed;
        Card.Visibility = Visibility.Visible;
        Card.ChangeView(null, 0, null, true);
        ShowHeader(c.Contact, c);
        ShowOverview(c.Contact, c);
        ShowNotes(c.Contact);
        _chats = [];
        ChatsPanel.Children.Clear();
        CallsPanel.Children.Clear();
        StatChats.Text = StatCalls.Text = "—";
        OpenChatButton.IsEnabled = false;
        DetailLoading.IsActive = true;

        if (Host.Workspace is not { } ws) return;
        try
        {
            var full = Host.Api.ContactAsync(c.Id, ct);
            var chats = Host.Api.ContactConversationsAsync(c.Id, ct);
            var calls = Host.Api.ContactCallsAsync(ws.Id, c.Id, ct);
            var contact = await full ?? c.Contact;
            if (ct.IsCancellationRequested) return;
            ShowHeader(contact, c);
            ShowOverview(contact, c);
            ShowNotes(contact);
            _chats = await chats;
            if (ct.IsCancellationRequested) return;
            ShowChats(_chats);
            var callList = await calls;
            if (ct.IsCancellationRequested) return;
            ShowCalls(callList);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log.Error("contact detail", ex);
            if (ct.IsCancellationRequested) return;
            ChatsPanel.Children.Clear();
            ChatsPanel.Children.Add(EmptyNote("", $"{Host.Strings["contactLoadFailed"]} — {ErrorText.For(ex, Host.Strings)}"));
        }
        finally
        {
            if (!ct.IsCancellationRequested) DetailLoading.IsActive = false;
        }
    }

    // ── Header ──

    private void ShowHeader(Contact contact, ContactItem item)
    {
        var s = Host.Strings;
        CardAvatar.DisplayName = item.Name;
        CardAvatar.Email = contact.Email;
        CardAvatar.ImageUrl = contact.AvatarUrl;
        CardAvatar.Os = item.Os;
        CardAvatar.CountryCode = item.CountryCode;
        CardName.Text = item.Name;
        var parts = new[] { contact.Company, contact.Email, contact.Phone }.Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        CardSub.Text = string.Join(" · ", parts);
        CardSub.Visibility = parts.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        CardTags.Children.Clear();
        foreach (var tag in (contact.Tags ?? []).Take(4)) CardTags.Children.Add(Chip(tag, "BrandBrush", "BrandSoftBrush"));
        CardTags.Visibility = CardTags.Children.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        EmailButton.Visibility = string.IsNullOrWhiteSpace(contact.Email) ? Visibility.Collapsed : Visibility.Visible;
        StatFirst.Text = contact.CreatedAt is { } created ? Display.ShortDate(created.ToLocalTime().DateTime, s.Language) : "—";
        StatUpdated.Text = (contact.UpdatedAt ?? contact.CreatedAt) is { } updated ? Display.ListStamp(updated, DateTimeOffset.Now, s) : "—";
    }

    // ── Overview ──

    private void ShowOverview(Contact contact, ContactItem item)
    {
        var s = Host.Strings;
        OverviewRows.Children.Clear();
        var geo = item.Profile?.Geo;
        var device = item.Profile?.Device;
        var place = string.Join(s.IsRightToLeft ? "، " : ", ", new[] { geo?.City, geo?.Region != geo?.City ? geo?.Region : null, geo?.Country }.Where(x => !string.IsNullOrWhiteSpace(x)));
        var deviceText = string.Join(" · ", new[] { device?.Browser, device?.Os, DeviceLabel(device?.Device, s) }.Where(x => !string.IsNullOrWhiteSpace(x)));

        Row("", s["emailLabel"], contact.Email, copy: true, ltr: true);
        Row("", s["phoneLabel"], contact.Phone, copy: true, ltr: true);
        Row("", s["contactCompany"], contact.Company);
        Row("\uE81D", s["visitorLocation"], place.Length > 0 ? place : null);
        Row("", s["visitorDevice"], deviceText.Length > 0 ? deviceText : null, ltr: true);
        Row("", s["contactVisitorCode"], contact.VisitorCode ?? contact.MetaString("anon_code"), copy: true, ltr: true);
        Row("", s["firstSeen"], contact.CreatedAt is { } at ? LongDate(at, s) : null);
        Row("", s["contactUpdated"], contact.UpdatedAt is { } up ? LongDate(up, s) : null);
        if (OverviewRows.Children.Count == 0) OverviewRows.Children.Add(EmptyNote("", s["contactNoNotes"]));
    }

    private void Row(string glyph, string label, string? value, bool copy = false, bool ltr = false)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        var g = new Grid { ColumnSpacing = 14, Padding = new Thickness(10, 10, 6, 10) };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.Children.Add(new Border
        {
            Width = 32,
            Height = 32,
            CornerRadius = new CornerRadius(9),
            Background = Palette.Resource("BrandSoftBrush"),
            Child = new FontIcon { Glyph = glyph, FontSize = 14, Foreground = Palette.Resource("BrandBrush") },
        });
        var name = new TextBlock { Text = label, FontSize = 13, Foreground = Palette.Resource("Text2Brush"), VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(name, 1);
        g.Children.Add(name);
        var text = new TextBlock
        {
            Text = value,
            FontSize = 14,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            IsTextSelectionEnabled = true,
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
            TextReadingOrder = TextReadingOrder.DetectFromContent,
        };
        if (ltr)
        {
            // Emails, phone numbers and codes read left to right even in Persian.
            text.FlowDirection = FlowDirection.LeftToRight;
            text.HorizontalAlignment = Host.Strings.IsRightToLeft ? HorizontalAlignment.Right : HorizontalAlignment.Left;
        }
        Grid.SetColumn(text, 2);
        g.Children.Add(text);
        if (copy)
        {
            var button = new Button { Style = (Style)Application.Current.Resources["IconButton"], Content = new FontIcon { Glyph = "", FontSize = 13 } };
            ToolTipService.SetToolTip(button, Host.Strings["copy"]);
            button.Click += (_, _) =>
            {
                var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
                package.SetText(value);
                Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
                ToolTipService.SetToolTip(button, Host.Strings["visitorCopied"]);
            };
            Grid.SetColumn(button, 3);
            g.Children.Add(button);
        }
        if (OverviewRows.Children.Count > 0)
            OverviewRows.Children.Add(new Border { Height = 1, Margin = new Thickness(56, 0, 10, 0), Background = Palette.Resource("LineBrush") });
        OverviewRows.Children.Add(g);
    }

    // ── Conversations ──

    private void ShowChats(IReadOnlyList<ContactConversation> chats)
    {
        var s = Host.Strings;
        ChatsPanel.Children.Clear();
        StatChats.Text = Digits.Localize(chats.Count.ToString(CultureInfo.InvariantCulture), s.Language);
        OpenChatButton.IsEnabled = chats.Count > 0;
        if (chats.Count == 0)
        {
            ChatsPanel.Children.Add(EmptyNote("", s["contactNoConversations"]));
            return;
        }
        foreach (var c in chats) ChatsPanel.Children.Add(ChatRow(c, s));
    }

    private Button ChatRow(ContactConversation c, Strings s)
    {
        var g = new Grid { ColumnSpacing = 14 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var ai = c.HandledByAi == true && c.HandledByOperator != true;
        var avatar = new Avatar
        {
            Size = 36,
            Kind = ai ? "ai" : "operator",
            DisplayName = c.OperatorName ?? s["aiReply"],
            ImageUrl = c.OperatorAvatar,
            VerticalAlignment = VerticalAlignment.Center,
        };
        g.Children.Add(avatar);

        var body = new StackPanel { Spacing = 3, VerticalAlignment = VerticalAlignment.Center };
        var top = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var status = c.Status ?? ConversationStatuses.Open;
        var (fore, back) = Palette.Status(status);
        top.Children.Add(Chip(StatusLabel(status, s), fore, back));
        if (c.HandledByAi == true) top.Children.Add(Chip(s["contactHandledByAi"], "AiBrush", "AiSoftBrush", ""));
        if (c.OperatorName is { Length: > 0 } op)
            top.Children.Add(new TextBlock { Text = op, FontSize = 12.5, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        body.Children.Add(top);
        var preview = Display.OneLine(c.LastMessageBody ?? c.Subject);
        body.Children.Add(new TextBlock
        {
            Text = preview.Length > 0 ? preview : "—",
            FontSize = 13,
            Foreground = Palette.Resource("Text2Brush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextReadingOrder = TextReadingOrder.DetectFromContent,
            MaxLines = 1,
        });
        Grid.SetColumn(body, 1);
        g.Children.Add(body);

        var meta = new StackPanel { Spacing = 3, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Right };
        if ((c.UpdatedAt ?? c.CreatedAt) is { } when)
            meta.Children.Add(new TextBlock { Text = Display.ListStamp(when, DateTimeOffset.Now, s), FontSize = 12, Foreground = Palette.Resource("Text3Brush"), HorizontalAlignment = HorizontalAlignment.Right });
        if (c.MessageCount is { } n)
            meta.Children.Add(new TextBlock { Text = s.Get("contactMessages", "n", Digits.Localize(n.ToString(CultureInfo.InvariantCulture), s.Language)), FontSize = 11.5, Foreground = Palette.Resource("Text3Brush"), HorizontalAlignment = HorizontalAlignment.Right });
        Grid.SetColumn(meta, 2);
        g.Children.Add(meta);

        var button = CardButton(g);
        button.Click += (_, _) => OpenConversation(c.Id);
        return button;
    }

    private void OnOpenLatest(object sender, RoutedEventArgs e)
    {
        if (_chats.FirstOrDefault() is { } latest) OpenConversation(latest.Id);
    }

    private static void OpenConversation(string id) => App.Current.Window?.Shell?.OpenConversation(id);

    private async void OnSendEmail(object sender, RoutedEventArgs e)
    {
        if (_shown?.Contact.Email is { Length: > 0 } email)
            await Windows.System.Launcher.LaunchUriAsync(new Uri("mailto:" + email));
    }

    // ── Calls ──

    private void ShowCalls(IReadOnlyList<ContactCall> calls)
    {
        var s = Host.Strings;
        CallsPanel.Children.Clear();
        StatCalls.Text = Digits.Localize(calls.Count.ToString(CultureInfo.InvariantCulture), s.Language);
        if (calls.Count == 0)
        {
            CallsPanel.Children.Add(EmptyNote("", s["contactNoCalls"]));
            return;
        }
        foreach (var call in calls) CallsPanel.Children.Add(CallRow(call, s));
    }

    private UIElement CallRow(ContactCall call, Strings s)
    {
        var video = call.CallType == "video";
        var missed = call.State is "missed" or "no_answer" or "rejected" or "failed" or "cancelled";
        var g = new Grid { ColumnSpacing = 14 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.Children.Add(new Border
        {
            Width = 36,
            Height = 36,
            CornerRadius = new CornerRadius(10),
            Background = Palette.Resource(missed ? "DangerSoftBrush" : "SuccessSoftBrush"),
            Child = new FontIcon { Glyph = video ? "" : "", FontSize = 15, Foreground = Palette.Resource(missed ? "DangerBrush" : "SuccessBrush") },
        });
        var body = new StackPanel { Spacing = 3, VerticalAlignment = VerticalAlignment.Center };
        var top = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        top.Children.Add(new TextBlock { Text = s[video ? "videoCall" : "voiceCall"], FontSize = 13.5, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        if (call.Direction is { Length: > 0 } dir)
            top.Children.Add(Chip(s[dir == "outbound" ? "callOutbound" : "callInbound"], "Text2Brush", "ElevatedBrush"));
        top.Children.Add(missed ? Chip(s["ccStateMissed"], "DangerBrush", "DangerSoftBrush") : Chip(s["callStateEnded"], "SuccessBrush", "SuccessSoftBrush"));
        // Recordings are a plan feature (the web's Recordings tab): only mentioned where the plan keeps them.
        if (call.RecordingAvailable == true && Host.Plan.CallRecordings) top.Children.Add(Chip(s["callRecorded"], "AiBrush", "AiSoftBrush", ""));
        body.Children.Add(top);
        var details = new[]
        {
            call.AgentName,
            call.DurationSeconds is > 0 and var d ? $"{s["ccHeaderDuration"]} {Duration(d, s)}" : null,
            call.WaitSeconds is > 0 and var w ? $"{s["ccWaitingLabel"]} {Duration(w, s)}" : null,
        }.Where(x => !string.IsNullOrWhiteSpace(x));
        body.Children.Add(new TextBlock { Text = string.Join(" · ", details), FontSize = 12.5, Foreground = Palette.Resource("Text2Brush"), TextTrimming = TextTrimming.CharacterEllipsis });
        Grid.SetColumn(body, 1);
        g.Children.Add(body);
        if (call.CreatedAt is { } when)
        {
            var stamp = new TextBlock { Text = Display.ListStamp(when, DateTimeOffset.Now, s), FontSize = 12, Foreground = Palette.Resource("Text3Brush"), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(stamp, 2);
            g.Children.Add(stamp);
        }
        if (call.ConversationId is { Length: > 0 } conversation)
        {
            var button = CardButton(g);
            button.Click += (_, _) => OpenConversation(conversation);
            return button;
        }
        return new Border { Style = (Style)Resources["ContactCard"], Padding = new Thickness(16, 12, 16, 12), Child = g };
    }

    // ── Notes and tags ──

    private void ShowNotes(Contact contact)
    {
        var s = Host.Strings;
        NotesText.Text = string.IsNullOrWhiteSpace(contact.Notes) ? s["contactNoNotes"] : contact.Notes.Trim();
        NotesText.Foreground = Palette.Resource(string.IsNullOrWhiteSpace(contact.Notes) ? "Text3Brush" : "TextBrush");
        TagsWrap.Children.Clear();
        foreach (var tag in contact.Tags ?? []) TagsWrap.Children.Add(Chip(tag, "BrandBrush", "BrandSoftBrush"));
        if (TagsWrap.Children.Count == 0) TagsWrap.Children.Add(new TextBlock { Text = s["noTags"], Foreground = Palette.Resource("Text3Brush") });
    }

    private void OnTabChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        var tag = sender.SelectedItem?.Tag as string ?? "overview";
        OverviewPanel.Visibility = tag == "overview" ? Visibility.Visible : Visibility.Collapsed;
        ChatsPanel.Visibility = tag == "chats" ? Visibility.Visible : Visibility.Collapsed;
        CallsPanel.Visibility = tag == "calls" ? Visibility.Visible : Visibility.Collapsed;
        NotesPanel.Visibility = tag == "notes" ? Visibility.Visible : Visibility.Collapsed;
    }

    // ── Pieces ──

    private Button CardButton(UIElement content) => new() { Content = content, Style = (Style)Resources["CardRowButton"] };

    private static Border Chip(string text, string fore, string back, string? glyph = null)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        if (glyph is not null) row.Children.Add(new FontIcon { Glyph = glyph, FontSize = 10, Foreground = Palette.Resource(fore) });
        row.Children.Add(new TextBlock { Text = text, FontSize = 11.5, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Palette.Resource(fore) });
        return new Border { Padding = new Thickness(8, 2, 8, 3), CornerRadius = new CornerRadius(8), Background = Palette.Resource(back), VerticalAlignment = VerticalAlignment.Center, Child = row };
    }

    private static UIElement EmptyNote(string glyph, string text)
    {
        var panel = new StackPanel { Spacing = 10, Padding = new Thickness(24, 36, 24, 36), HorizontalAlignment = HorizontalAlignment.Center };
        panel.Children.Add(new Border
        {
            Width = 52,
            Height = 52,
            CornerRadius = new CornerRadius(14),
            HorizontalAlignment = HorizontalAlignment.Center,
            Background = Palette.Resource("ElevatedBrush"),
            Child = new FontIcon { Glyph = glyph, FontSize = 20, Foreground = Palette.Resource("Text3Brush") },
        });
        panel.Children.Add(new TextBlock { Text = text, HorizontalAlignment = HorizontalAlignment.Center, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, Foreground = Palette.Resource("Text2Brush") });
        return panel;
    }

    private static string StatusLabel(string status, Strings s) => status switch
    {
        ConversationStatuses.Open => s["filterOpen"],
        ConversationStatuses.Pending => s["filterPending"],
        ConversationStatuses.Resolved => s["filterResolved"],
        ConversationStatuses.Closed => s["statusClosed"],
        _ => status,
    };

    private static string? DeviceLabel(string? device, Strings s) => device?.ToLowerInvariant() switch
    {
        "mobile" => s["deviceMobile"],
        "tablet" => s["deviceTablet"],
        "desktop" => s["deviceDesktop"],
        _ => device,
    };

    private static string LongDate(DateTimeOffset when, Strings s) =>
        $"{Display.ShortDate(when.ToLocalTime().DateTime, s.Language)} · {Display.ClockTime(when, s.Language)}";

    private static string Duration(int seconds, Strings s)
    {
        var t = TimeSpan.FromSeconds(seconds);
        var text = t.TotalHours >= 1 ? t.ToString(@"h\:mm\:ss", CultureInfo.InvariantCulture) : t.ToString(@"m\:ss", CultureInfo.InvariantCulture);
        return Digits.Localize(text, s.Language);
    }
}
