using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.Controls;

/// <summary>
/// Who is asking — drawn at the top of a platform-support conversation in
/// the support team's inbox (the web's SupportRequesterCard, Android's
/// RequesterCardView): the site user with the app they wrote from, then each
/// of their workspaces with its plan and this month's use against the plan's
/// limits. Built from the internal notice the server wrote when the
/// conversation started; nothing is asked of the server and nothing stored.
/// </summary>
public sealed partial class RequesterCardView : ContentControl
{
    private RequesterCard? _card;
    private string? _avatarUrl;

    public RequesterCardView()
    {
        HorizontalAlignment = HorizontalAlignment.Stretch;
        HorizontalContentAlignment = HorizontalAlignment.Center;
        IsTabStop = false;
        // Drawn in code with the theme's brushes: drawn again when the theme changes.
        Loaded += (_, _) => Palette.ThemeChanged += Draw;
        Unloaded += (_, _) => Palette.ThemeChanged -= Draw;
    }

    /// <summary>The notice's card.</summary>
    public RequesterCard? Card
    {
        get => _card;
        set
        {
            if (ReferenceEquals(_card, value)) return;
            _card = value;
            Draw();
        }
    }

    /// <summary>The site user's photo, as their contact in the support workspace carries it.</summary>
    public string? PhotoUrl
    {
        get => _avatarUrl;
        set
        {
            if (_avatarUrl == value) return;
            _avatarUrl = value;
            Draw();
        }
    }

    private static Strings S => App.Current.Host.Strings;

    private void Draw()
    {
        if (_card is not { } card)
        {
            Content = null;
            return;
        }
        var s = S;
        var body = new StackPanel();
        body.Children.Add(Header(s));
        body.Children.Add(Identity(card, s));
        if (card.Workspaces.Count > 0) body.Children.Add(Workspaces(card, s));
        if (card.CapturedAt is { } at)
        {
            var foot = Text(s.Get("requesterAsOf", "date", RequesterText.Date(at, s)), 11, "Text3Brush");
            body.Children.Add(new Border
            {
                Padding = new Thickness(16, 8, 16, 9),
                BorderBrush = Palette.Resource("LineBrush"),
                BorderThickness = new Thickness(0, 1, 0, 0),
                Child = foot,
            });
        }
        var frame = new Border
        {
            Margin = new Thickness(0, 10, 0, 12),
            MaxWidth = 660,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            CornerRadius = new CornerRadius(16),
            Background = Palette.Resource("SurfaceBrush"),
            BorderBrush = Palette.Resource("LineBrush"),
            BorderThickness = new Thickness(1),
            FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
            Child = body,
        };
        AutomationProperties.SetName(frame, s["requesterTitle"]);
        Content = frame;
    }

    // ── Header: what this is, and that the site user never sees it ──

    private static FrameworkElement Header(Strings s)
    {
        var violet = ChannelInfo.Brush(ClientPlatforms.SupportChannel);
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(new FontIcon { Glyph = "", FontSize = 13, Foreground = violet, VerticalAlignment = VerticalAlignment.Center });
        var title = Text(s["requesterTitle"], 12.5, "TextBrush", semibold: true);
        title.Foreground = violet;
        Grid.SetColumn(title, 1);
        grid.Children.Add(title);
        var only = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5, HorizontalAlignment = HorizontalAlignment.Right };
        only.Children.Add(new FontIcon { Glyph = "", FontSize = 10.5, Foreground = Palette.Resource("Text3Brush"), VerticalAlignment = VerticalAlignment.Center });
        var note = Text(s["requesterTeamOnly"], 11, "Text3Brush");
        note.TextTrimming = TextTrimming.CharacterEllipsis;
        note.TextWrapping = TextWrapping.NoWrap;
        only.Children.Add(note);
        Grid.SetColumn(only, 2);
        grid.Children.Add(only);
        return new Border
        {
            Padding = new Thickness(16, 9, 16, 9),
            CornerRadius = new CornerRadius(15, 15, 0, 0),
            Background = ChannelInfo.SoftBrush(ClientPlatforms.SupportChannel),
            Child = grid,
        };
    }

    // ── The person ──

    private FrameworkElement Identity(RequesterCard card, Strings s)
    {
        var grid = new Grid { ColumnSpacing = 14, Padding = new Thickness(16, 14, 16, 14) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(new Avatar
        {
            Size = 52,
            DisplayName = card.Name ?? card.Email,
            Email = card.Email,
            ImageUrl = _avatarUrl,
            VerticalAlignment = VerticalAlignment.Top,
        });

        var words = new StackPanel { Spacing = 5, VerticalAlignment = VerticalAlignment.Center };
        if (card.Name is { } name)
        {
            var n = Text(name, 16, "TextBrush", semibold: true);
            n.FontWeight = FontWeights.Bold;
            n.IsTextSelectionEnabled = true;
            n.TextReadingOrder = TextReadingOrder.DetectFromContent;
            words.Children.Add(n);
        }

        // Addresses and numbers read left to right in every language, each one a click to copy.
        var reach = new WrapPanel { Spacing = 6 };
        if (card.Email is { } email) reach.Children.Add(Copyable("", email, s));
        if (card.Phone is { } phone) reach.Children.Add(Copyable("", phone, s));
        if (card.Website is { } site) reach.Children.Add(Copyable("", site, s));
        if (reach.Children.Count > 0) words.Children.Add(reach);

        if (card.Company is { } company)
        {
            var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
            line.Children.Add(new FontIcon { Glyph = "", FontSize = 12, Foreground = Palette.Resource("Text3Brush"), VerticalAlignment = VerticalAlignment.Center });
            var c = Text(company, 12.5, "Text2Brush");
            c.TextReadingOrder = TextReadingOrder.DetectFromContent;
            line.Children.Add(c);
            words.Children.Add(line);
        }

        var facts = new WrapPanel { Spacing = 6, Margin = new Thickness(0, 3, 0, 0) };
        var violet = ChannelInfo.Brush(ClientPlatforms.SupportChannel);
        facts.Children.Add(Chip(ChannelInfo.PlatformGlyph(card.ClientPlatform), ClientPlatforms.UserLabel(card.ClientPlatform, s), violet, ChannelInfo.SoftBrush(ClientPlatforms.SupportChannel)));
        if (card.SourceWorkspace is { } from)
            facts.Children.Add(Chip("", s.Get("requesterFrom", "name", from), Palette.Resource("Text2Brush"), Palette.Resource("ElevatedBrush")));
        if (card.MemberSince is { } since)
            facts.Children.Add(Chip("", s.Get("requesterMemberSince", "date", RequesterText.Date(since, s)), Palette.Resource("Text2Brush"), Palette.Resource("ElevatedBrush")));
        words.Children.Add(facts);

        Grid.SetColumn(words, 1);
        grid.Children.Add(words);
        return grid;
    }

    /// <summary>An address that copies itself when clicked.</summary>
    private static Button Copyable(string glyph, string value, Strings s)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, FlowDirection = FlowDirection.LeftToRight };
        line.Children.Add(new FontIcon { Glyph = glyph, FontSize = 11.5, Foreground = Palette.Resource("Text3Brush"), VerticalAlignment = VerticalAlignment.Center });
        var text = Text(value, 12.5, "TextBrush");
        text.TextWrapping = TextWrapping.NoWrap;
        text.TextTrimming = TextTrimming.CharacterEllipsis;
        text.MaxWidth = 280;
        line.Children.Add(text);
        var button = new Button
        {
            Content = line,
            Padding = new Thickness(8, 3, 9, 4),
            CornerRadius = new CornerRadius(8),
            Background = Palette.Resource("ElevatedBrush"),
            BorderThickness = new Thickness(0),
        };
        var tip = $"{s["copy"]} · {value}";
        ToolTipService.SetToolTip(button, tip);
        AutomationProperties.SetName(button, tip);
        button.Click += (_, _) =>
        {
            TextClipboard.Copy(value);
            ToolTipService.SetToolTip(button, s["requesterCopied"]);
        };
        return button;
    }

    private static Border Chip(string glyph, string text, Brush fore, Brush back)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5 };
        line.Children.Add(new FontIcon { Glyph = glyph, FontSize = 11, Foreground = fore, VerticalAlignment = VerticalAlignment.Center });
        var t = new TextBlock { Text = text, FontSize = 11.5, FontWeight = FontWeights.SemiBold, Foreground = fore, VerticalAlignment = VerticalAlignment.Center, TextReadingOrder = TextReadingOrder.DetectFromContent };
        line.Children.Add(t);
        return new Border { Padding = new Thickness(9, 3, 10, 4), CornerRadius = new CornerRadius(10), Background = back, Child = line };
    }

    // ── Their workspaces ──

    private static FrameworkElement Workspaces(RequesterCard card, Strings s)
    {
        var panel = new StackPanel { Spacing = 10, Padding = new Thickness(16, 12, 16, 14) };
        var head = Text(s.Get("requesterWorkspaces", "count", card.WorkspaceCount), 11.5, "Text3Brush", semibold: true);
        panel.Children.Add(head);
        foreach (var ws in card.Workspaces) panel.Children.Add(Workspace(ws, s));
        var more = card.WorkspaceCount - card.Workspaces.Count;
        if (more > 0) panel.Children.Add(Text(s.Get("requesterMore", "count", more), 11.5, "Text3Brush"));
        return new Border
        {
            BorderBrush = Palette.Resource("LineBrush"),
            BorderThickness = new Thickness(0, 1, 0, 0),
            Child = panel,
        };
    }

    private static FrameworkElement Workspace(RequesterWorkspace ws, Strings s)
    {
        var panel = new StackPanel { Spacing = 10 };

        // Name and role, and the plan with its state on the far side.
        var top = new Grid { ColumnSpacing = 10 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition());
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var tile = new Border { Width = 34, Height = 34, CornerRadius = new CornerRadius(10), Background = Palette.Resource("BrandSoftBrush") };
        tile.Child = new FontIcon { Glyph = "", FontSize = 15, Foreground = Palette.Resource("BrandBrush") };
        top.Children.Add(tile);
        var names = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        var title = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var wsName = Text(ws.Name, 14, "TextBrush", semibold: true);
        wsName.TextWrapping = TextWrapping.NoWrap;
        wsName.TextTrimming = TextTrimming.CharacterEllipsis;
        wsName.TextReadingOrder = TextReadingOrder.DetectFromContent;
        wsName.IsTextSelectionEnabled = true;
        title.Children.Add(wsName);
        if (ws.Role is { } role)
            title.Children.Add(new Border { Padding = new Thickness(7, 1, 7, 2), CornerRadius = new CornerRadius(7), Background = Palette.Resource("ElevatedBrush"), VerticalAlignment = VerticalAlignment.Center, Child = Text(RequesterText.Role(role, s), 10.5, "Text2Brush", semibold: true) });
        names.Children.Add(title);
        if (RequesterText.Renewal(ws, s) is { } renewal) names.Children.Add(Text(renewal, 11.5, "Text3Brush"));
        Grid.SetColumn(names, 1);
        top.Children.Add(names);
        var (fore, back) = PlanColours(ws);
        var plan = ws.PlanLabel(s);
        if (ws.PlanStatus is { } status) plan = $"{plan} · {RequesterText.PlanStatus(status, s)}";
        var planChip = new Border { Padding = new Thickness(10, 3, 10, 4), CornerRadius = new CornerRadius(10), Background = Palette.Resource(back), VerticalAlignment = VerticalAlignment.Center };
        var planText = Text(plan, 11.5, fore, semibold: true);
        planText.TextWrapping = TextWrapping.NoWrap;
        planText.TextReadingOrder = TextReadingOrder.DetectFromContent;
        planChip.Child = planText;
        Grid.SetColumn(planChip, 2);
        top.Children.Add(planChip);
        panel.Children.Add(top);

        // This month's use, each against the plan's limit with a bar when it has one.
        var grid = new AdaptiveGrid { MaxColumns = 4, MinColumnWidth = 128, Spacing = 8 };
        grid.Children.Add(Metric("", s["requesterOperators"], ws.Operators.Text(s.Language), ws.Operators.Share));
        grid.Children.Add(Metric("", s["requesterContacts"], ws.Contacts.Text(s.Language), ws.Contacts.Share));
        grid.Children.Add(Metric("", s["requesterConversations"], ws.Conversations.Text(s.Language), ws.Conversations.Share));
        grid.Children.Add(Metric("", s["requesterVisitors"], ws.Visitors.Text(s.Language), ws.Visitors.Share));
        grid.Children.Add(Metric("", s["requesterAiCredits"], ws.AiCredits.Text(s.Language), ws.AiCredits.Share));
        grid.Children.Add(Metric("", s["requesterMessages"], RequesterText.Number(ws.Messages, s.Language), null));
        grid.Children.Add(Metric("", s["requesterCallMinutes"], RequesterText.Number(ws.CallMinutes, s.Language), null));
        double? storageShare = ws.StorageLimitGb is > 0 and { } gb ? Math.Clamp(ws.StorageBytes / (gb * 1024d * 1024 * 1024), 0, 1) : null;
        grid.Children.Add(Metric("", s["requesterStorage"], RequesterText.Storage(ws, s.Language), storageShare));
        var month = new StackPanel { Spacing = 6 };
        month.Children.Add(Text(s["requesterThisMonth"], 11, "Text3Brush", semibold: true));
        month.Children.Add(grid);
        panel.Children.Add(month);

        return new Border
        {
            Padding = new Thickness(12, 12, 12, 12),
            CornerRadius = new CornerRadius(12),
            Background = Palette.Resource("Surface2Brush"),
            BorderBrush = Palette.Resource("LineBrush"),
            BorderThickness = new Thickness(1),
            Child = panel,
        };
    }

    /// <summary>The plan chip's colours: green while active, brand on trial, red past due, grey otherwise.</summary>
    private static (string Fore, string Back) PlanColours(RequesterWorkspace ws) => !ws.HasPlan
        ? ("Text2Brush", "ElevatedBrush")
        : ws.PlanStatus switch
        {
            "active" => ("SuccessBrush", "SuccessSoftBrush"),
            "trialing" => ("BrandBrush", "BrandSoftBrush"),
            "past_due" or "unpaid" => ("DangerBrush", "DangerSoftBrush"),
            "canceled" or "cancelled" => ("Text2Brush", "ElevatedBrush"),
            _ => ("BrandBrush", "BrandSoftBrush"),
        };

    private static FrameworkElement Metric(string glyph, string label, string value, double? share)
    {
        var panel = new StackPanel { Spacing = 4 };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5 };
        head.Children.Add(new FontIcon { Glyph = glyph, FontSize = 11, Foreground = Palette.Resource("Text3Brush"), VerticalAlignment = VerticalAlignment.Center });
        var l = Text(label, 11, "Text3Brush");
        l.TextWrapping = TextWrapping.NoWrap;
        l.TextTrimming = TextTrimming.CharacterEllipsis;
        head.Children.Add(l);
        panel.Children.Add(head);
        var v = Text(value, 13.5, "TextBrush", semibold: true);
        v.FlowDirection = FlowDirection.LeftToRight;
        v.HorizontalAlignment = HorizontalAlignment.Left;
        v.TextWrapping = TextWrapping.NoWrap;
        v.IsTextSelectionEnabled = true;
        var holder = new Grid();
        holder.Children.Add(v);
        panel.Children.Add(holder);
        if (share is { } used)
        {
            // Nearly at the limit reads amber, at it red: the reason someone writes to support is often here.
            var brush = used >= 1 ? "DangerBrush" : used >= 0.8 ? "WarningBrush" : "BrandBrush";
            var track = new Grid { Height = 4, CornerRadius = new CornerRadius(2), Background = Palette.Resource("ElevatedBrush") };
            track.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(used, 0.0001), GridUnitType.Star) });
            track.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(1 - used, 0.0001), GridUnitType.Star) });
            track.Children.Add(new Border { CornerRadius = new CornerRadius(2), Background = Palette.Resource(brush) });
            panel.Children.Add(track);
        }
        return new Border
        {
            Padding = new Thickness(10, 8, 10, 9),
            CornerRadius = new CornerRadius(10),
            Background = Palette.Resource("SurfaceBrush"),
            Child = panel,
        };
    }

    private static TextBlock Text(string text, double size, string brush, bool semibold = false) => new()
    {
        Text = text,
        FontSize = size,
        Foreground = Palette.Resource(brush),
        FontWeight = semibold ? FontWeights.SemiBold : FontWeights.Normal,
        TextWrapping = TextWrapping.Wrap,
        VerticalAlignment = VerticalAlignment.Center,
    };
}
