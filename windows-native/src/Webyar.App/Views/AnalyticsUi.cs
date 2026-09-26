using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Webyar.App.Controls;
using Webyar.App.Helpers;
using Webyar.Core.Analytics;
using Webyar.Core.Api;
using Webyar.Core.Localization;
using Windows.UI;

namespace Webyar.App.Views;

/// <summary>One line of a ranked list.</summary>
public sealed record BarItem(string Id, string Label, int Value)
{
    public string? Secondary { get; init; }
    /// <summary>The country's two letters before the label (Windows has no flag emoji).</summary>
    public string? Badge { get; init; }
    /// <summary>A Segoe Fluent glyph before the label.</summary>
    public string? Glyph { get; init; }
    /// <summary>URLs and campaign names read left to right in every language.</summary>
    public bool Ltr { get; init; }
}

/// <summary>
/// The analytics dashboard's pieces, built in code as the Mac app's views:
/// white cards with a coloured icon and title, headline tiles with their
/// change from the period before, ranked lists over share bars, the three
/// summary tiles above a report, and the events table.
/// </summary>
public sealed class AnalyticsUi(Strings strings)
{
    public Strings Strings { get; } = strings;

    /// <summary>Whether Windows wants animations (off with "Animation effects" switched off).</summary>
    public static bool AnimationsOn
    {
        get
        {
            try
            {
                return new Windows.UI.ViewManagement.UISettings().AnimationsEnabled;
            }
            catch (Exception)
            {
                return true;
            }
        }
    }

    public static SolidColorBrush Tint(uint rgb) => new(Color.FromArgb(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb));

    /// <summary>The tint at 14%, for icon tiles.</summary>
    public static SolidColorBrush Soft(uint rgb) => new(Color.FromArgb(0x24, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb));

    private static Style? Resource(string key) => Application.Current.Resources.TryGetValue(key, out var v) ? v as Style : null;

    public static Border Tile(string glyph, uint tint, double size, double radius, double glyphSize, bool round = false) => new()
    {
        Width = size,
        Height = size,
        CornerRadius = new CornerRadius(round ? size / 2 : radius),
        Background = Soft(tint),
        VerticalAlignment = VerticalAlignment.Center,
        Child = new FontIcon { Glyph = glyph, FontSize = glyphSize, Foreground = Tint(tint) },
    };

    public static AdaptiveGrid Columns(IEnumerable<UIElement> children, int max, double minWidth)
    {
        var grid = new AdaptiveGrid { MaxColumns = max, MinColumnWidth = minWidth, Spacing = max == 3 && minWidth < 200 ? 12 : 16 };
        foreach (var c in children) grid.Children.Add(c);
        return grid;
    }

    /// <summary>A white card with a small coloured icon, a title, optional controls, and its content.</summary>
    public Border Card(string title, string glyph, uint tint, UIElement? controls, UIElement content)
    {
        var head = new Grid { ColumnSpacing = 8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(new FontIcon { Glyph = glyph, FontSize = 12, Foreground = Tint(tint), VerticalAlignment = VerticalAlignment.Center });
        var t = new TextBlock { Text = title, FontSize = 14, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Palette.Resource("TextBrush") };
        Grid.SetColumn(t, 1);
        head.Children.Add(t);
        if (controls is FrameworkElement c)
        {
            Grid.SetColumn(c, 2);
            head.Children.Add(c);
        }
        var body = new StackPanel { Spacing = 14 };
        body.Children.Add(head);
        body.Children.Add(content);
        return new Border { Style = Resource("PanelBorder"), Padding = new Thickness(16), CornerRadius = new CornerRadius(16), Child = body };
    }

    /// <summary>A row of toggle buttons where one is on, as the Mac's segmented pickers.</summary>
    public StackPanel Segmented(IReadOnlyList<(string Label, string Tag)> options, string selected, Action<string> pick)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
        var style = Application.Current.Resources.TryGetValue("DefaultToggleButtonStyle", out var s) ? s as Style : null;
        foreach (var (label, tag) in options)
        {
            var b = new ToggleButton { Content = label, Tag = tag, IsChecked = tag == selected, CornerRadius = new CornerRadius(8), Padding = new Thickness(12, 3, 12, 3), FontSize = 12.5 };
            if (style is not null) b.Style = style;
            b.Click += (_, _) =>
            {
                b.IsChecked = true;
                if (tag != selected) pick(tag);
            };
            row.Children.Add(b);
        }
        return row;
    }

    /// <summary>A headline number: its icon on a soft tint, the value large, the label under it, and its change.</summary>
    public Border Kpi(string glyph, uint tint, string label, string? value, double? change, bool higherIsBetter, string changeHelp)
    {
        var top = new Grid();
        top.Children.Add(new Border
        {
            Width = 28,
            Height = 28,
            CornerRadius = new CornerRadius(14),
            Background = Soft(tint),
            HorizontalAlignment = HorizontalAlignment.Left,
            Child = new FontIcon { Glyph = glyph, FontSize = 12, Foreground = Tint(tint) },
        });
        if (change is { } ch && value is not null) top.Children.Add(ChangeChip(ch, higherIsBetter, changeHelp));

        var text = new StackPanel { Spacing = 3 };
        if (value is not null)
            text.Children.Add(new TextBlock { Text = value, FontSize = 24, FontWeight = FontWeights.Bold, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Palette.Resource("TextBrush") });
        else
            text.Children.Add(new Border { Width = 80, Height = 26, CornerRadius = new CornerRadius(6), Background = Palette.Resource("ElevatedBrush"), HorizontalAlignment = HorizontalAlignment.Left });
        text.Children.Add(new TextBlock { Text = label, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Palette.Resource("Text2Brush") });

        var body = new StackPanel { Spacing = 10 };
        body.Children.Add(top);
        body.Children.Add(text);
        return new Border { Style = Resource("PanelBorder"), Padding = new Thickness(14), CornerRadius = new CornerRadius(14), Child = body };
    }

    /// <summary>"▲ 12%": green when the number moved the good way, red when the bad way, grey when flat.</summary>
    private Border ChangeChip(double change, bool higherIsBetter, string help)
    {
        var flat = Math.Abs(change) < 0.005;
        var good = change > 0 == higherIsBetter;
        var key = flat ? "Text2Brush" : good ? "SuccessBrush" : "DangerBrush";
        var soft = flat ? "ElevatedBrush" : good ? "SuccessSoftBrush" : "DangerSoftBrush";
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3 };
        row.Children.Add(new FontIcon { Glyph = flat ? "" : change > 0 ? "" : "", FontSize = 9, Foreground = Palette.Resource(key), VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(new TextBlock { Text = AnalyticsFormat.Percent(Math.Abs(change), Strings), FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = Palette.Resource(key) });
        var chip = new Border
        {
            Padding = new Thickness(7, 3, 7, 3),
            CornerRadius = new CornerRadius(10),
            Background = Palette.Resource(soft),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Center,
            FlowDirection = FlowDirection.LeftToRight,
            Child = row,
        };
        ToolTipService.SetToolTip(chip, help);
        return chip;
    }

    /// <summary>A grey block while a report is on its way, with a small ring when it really is loading.</summary>
    public Border Placeholder(double height, bool loading) => new()
    {
        Height = height,
        CornerRadius = new CornerRadius(10),
        Background = Palette.Resource("ElevatedBrush"),
        Opacity = 0.6,
        Child = loading ? new ProgressRing { IsActive = true, Width = 20, Height = 20 } : null,
    };

    public StackPanel Empty(string glyph, string title, string message, uint tint)
    {
        var panel = new StackPanel { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, Padding = new Thickness(0, 18, 0, 18), MaxWidth = 360 };
        var tile = Tile(glyph, tint, 44, 22, 18, round: true);
        tile.HorizontalAlignment = HorizontalAlignment.Center;
        panel.Children.Add(tile);
        panel.Children.Add(new TextBlock { Text = title, FontSize = 14, FontWeight = FontWeights.SemiBold, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, HorizontalAlignment = HorizontalAlignment.Center, Foreground = Palette.Resource("TextBrush") });
        panel.Children.Add(new TextBlock { Text = message, FontSize = 12, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, HorizontalAlignment = HorizontalAlignment.Center, Foreground = Palette.Resource("Text2Brush") });
        return panel;
    }

    /// <summary>A ranked list: each line's label and count over a bar showing its share of the whole.</summary>
    public UIElement BarList(IReadOnlyList<BarItem> items, bool loading, string unit, int limit, uint tint)
    {
        if (loading)
        {
            var skeleton = new StackPanel { Spacing = 14 };
            for (var i = 0; i < 4; i++) skeleton.Children.Add(new Border { Height = 22, CornerRadius = new CornerRadius(6), Background = Palette.Resource("ElevatedBrush"), Opacity = 0.7 });
            return skeleton;
        }
        if (items.Count == 0) return Empty("", Strings["waNoData"], Strings["waNoDataHint"], tint);

        var total = Math.Max(1, items.Sum(i => i.Value));
        var top = Math.Max(1, items.Max(i => i.Value));
        var list = new StackPanel { Spacing = 12 };
        foreach (var item in items.Take(limit))
        {
            var line = new Grid { ColumnSpacing = 8 };
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(42) });
            if (item.Badge is { } badge)
                line.Children.Add(new Border { CornerRadius = new CornerRadius(4), Padding = new Thickness(4, 1, 4, 1), Background = Palette.Resource("ElevatedBrush"), VerticalAlignment = VerticalAlignment.Center, Child = new TextBlock { Text = badge, FontSize = 10, FontWeight = FontWeights.SemiBold, Foreground = Palette.Resource("Text2Brush") } });
            else if (item.Glyph is { } glyph)
                line.Children.Add(new FontIcon { Glyph = glyph, FontSize = 12, Width = 16, Foreground = Palette.Resource("Text2Brush"), VerticalAlignment = VerticalAlignment.Center });
            var label = new TextBlock
            {
                Text = item.Label,
                FontSize = 12.5,
                FontWeight = FontWeights.Medium,
                TextTrimming = TextTrimming.CharacterEllipsis,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = Palette.Resource("TextBrush"),
            };
            if (item.Ltr)
            {
                label.FlowDirection = FlowDirection.LeftToRight;
                label.TextAlignment = Strings.IsRightToLeft ? TextAlignment.Right : TextAlignment.Left;
            }
            ToolTipService.SetToolTip(label, item.Label);
            Grid.SetColumn(label, 1);
            line.Children.Add(label);
            if (item.Secondary is { } secondary)
            {
                var sec = new TextBlock { Text = secondary, FontSize = 11, Foreground = Palette.Resource("Text3Brush"), VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(sec, 2);
                line.Children.Add(sec);
            }
            var count = new TextBlock { Text = AnalyticsFormat.Count(item.Value, Strings), FontSize = 12.5, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, Foreground = Palette.Resource("TextBrush") };
            Grid.SetColumn(count, 3);
            line.Children.Add(count);
            var share = new TextBlock { Text = AnalyticsFormat.Percent((double)item.Value / total, Strings), FontSize = 11, TextAlignment = TextAlignment.Right, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center, Foreground = Palette.Resource("Text2Brush") };
            Grid.SetColumn(share, 4);
            line.Children.Add(share);

            var row = new StackPanel { Spacing = 6 };
            row.Children.Add(line);
            row.Children.Add(ShareBar((double)item.Value / top, tint));
            ToolTipService.SetToolTip(row, $"{AnalyticsFormat.Count(item.Value, Strings)} {unit}");
            list.Children.Add(row);
        }
        return list;
    }

    /// <summary>A thin rounded bar, filled to `fraction` (0–1) from the reading edge.</summary>
    public static Grid ShareBar(double fraction, uint tint)
    {
        var f = Math.Clamp(fraction, 0, 1);
        var bar = new Grid { Height = 6, CornerRadius = new CornerRadius(3), Background = Palette.Resource("ElevatedBrush") };
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(f, 0.012), GridUnitType.Star) });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(0, 1 - f), GridUnitType.Star) });
        var c = Tint(tint).Color;
        bar.Children.Add(new Border
        {
            CornerRadius = new CornerRadius(3),
            Background = new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0, 0),
                EndPoint = new Windows.Foundation.Point(1, 0),
                GradientStops =
                {
                    new GradientStop { Color = Color.FromArgb(0xBF, c.R, c.G, c.B), Offset = 0 },
                    new GradientStop { Color = c, Offset = 1 },
                },
            },
        });
        return bar;
    }

    /// <summary>Three tiles above a ranked report: its total, the line in first place and how many lines there are.</summary>
    public UIElement WithInsights(IReadOnlyList<BarItem> items, bool loaded, string totalLabel, uint tint, UIElement report)
    {
        var root = new StackPanel { Spacing = 16 };
        if (loaded && items.Count > 0)
        {
            var total = items.Sum(i => i.Value);
            var top = items.MaxBy(i => i.Value)!;
            var leader = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
            if (top.Badge is { } badge) leader.Children.Add(new TextBlock { Text = badge, FontSize = 12, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, Foreground = Palette.Resource("Text2Brush") });
            var name = new TextBlock { Text = top.Label, FontSize = 15, FontWeight = FontWeights.Bold, MaxWidth = 180, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, Foreground = Palette.Resource("TextBrush") };
            if (top.Ltr) name.FlowDirection = FlowDirection.LeftToRight;
            ToolTipService.SetToolTip(name, top.Label);
            leader.Children.Add(name);
            leader.Children.Add(new TextBlock { Text = AnalyticsFormat.Percent((double)top.Value / Math.Max(1, total), Strings), FontSize = 12, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, Foreground = Palette.Resource("Text2Brush") });
            root.Children.Add(Columns(
            [
                Insight("", totalLabel, Big(AnalyticsFormat.Count(total, Strings)), tint),
                Insight("", Strings["waLeader"], leader, tint),
                Insight("", Strings["waDistinct"], Big(AnalyticsFormat.Count(items.Count, Strings)), tint),
            ], 3, 170));
        }
        root.Children.Add(report);
        return root;
    }

    private static TextBlock Big(string text) => new() { Text = text, FontSize = 20, FontWeight = FontWeights.Bold, Foreground = Palette.Resource("TextBrush") };

    private static Border Insight(string glyph, string label, UIElement value, uint tint)
    {
        var grid = new Grid { ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(Tile(glyph, tint, 30, 9, 12));
        var text = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new Grid { Height = 26, Children = { value } });
        text.Children.Add(new TextBlock { Text = label, FontSize = 11.5, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Palette.Resource("Text2Brush") });
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        return new Border { Style = Resource("PanelBorder"), Padding = new Thickness(12), CornerRadius = new CornerRadius(14), Child = grid };
    }

    /// <summary>The custom events: name, how often, in how many visits, and the share of visits that fired it.</summary>
    public UIElement EventsTable(IReadOnlyList<WebAnalyticsEvent> rows, uint tint)
    {
        var best = Math.Max(0.0001, rows.Select(r => r.ConversionRate ?? 0).DefaultIfEmpty(0).Max());
        var table = new StackPanel();
        Grid Row()
        {
            var g = new Grid { Padding = new Thickness(4, 10, 4, 10), ColumnSpacing = 8 };
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) });
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
            return g;
        }
        TextBlock Cell(Grid g, int column, string text, bool header = false, bool strong = false)
        {
            var t = new TextBlock
            {
                Text = text,
                FontSize = header ? 11 : 13,
                FontWeight = header || strong ? FontWeights.SemiBold : FontWeights.Normal,
                Foreground = Palette.Resource(header ? "Text3Brush" : "TextBrush"),
                TextTrimming = TextTrimming.CharacterEllipsis,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = column == 0 ? HorizontalAlignment.Stretch : HorizontalAlignment.Right,
            };
            Grid.SetColumn(t, column);
            g.Children.Add(t);
            return t;
        }

        var head = Row();
        head.Padding = new Thickness(4, 0, 4, 8);
        Cell(head, 0, Strings["waEvents"], header: true);
        Cell(head, 1, Strings["waEventCount"], header: true);
        Cell(head, 2, Strings["waEventSessions"], header: true);
        Cell(head, 3, Strings["waConversion"], header: true);
        table.Children.Add(head);

        foreach (var e in rows)
        {
            table.Children.Add(new Border { Height = 1, Background = Palette.Resource("LineBrush") });
            var r = Row();
            var name = Cell(r, 0, e.EventName, strong: true);
            name.FlowDirection = FlowDirection.LeftToRight;
            name.TextAlignment = Strings.IsRightToLeft ? TextAlignment.Right : TextAlignment.Left;
            Cell(r, 1, AnalyticsFormat.Count(e.Count ?? 0, Strings));
            Cell(r, 2, AnalyticsFormat.Count(e.UniqueSessions ?? 0, Strings));
            var conversion = new Grid { ColumnSpacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            conversion.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });
            conversion.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var bar = ShareBar((e.ConversionRate ?? 0) / best, tint);
            bar.VerticalAlignment = VerticalAlignment.Center;
            conversion.Children.Add(bar);
            var pct = new TextBlock { Text = AnalyticsFormat.Percent(e.ConversionRate ?? 0, Strings), FontSize = 13, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, Foreground = Palette.Resource("TextBrush") };
            Grid.SetColumn(pct, 1);
            conversion.Children.Add(pct);
            Grid.SetColumn(conversion, 3);
            r.Children.Add(conversion);
            table.Children.Add(r);
        }
        return table;
    }
}
