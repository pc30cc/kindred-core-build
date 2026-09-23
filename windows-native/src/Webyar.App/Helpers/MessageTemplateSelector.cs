using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Webyar.App.ViewModels;

namespace Webyar.App.Helpers;

/// <summary>Visitor bubbles on the leading edge, the team's on the trailing edge, notices and days in the middle.</summary>
public sealed partial class MessageTemplateSelector : DataTemplateSelector
{
    public DataTemplate? Incoming { get; set; }
    public DataTemplate? Outgoing { get; set; }
    public DataTemplate? System { get; set; }
    public DataTemplate? Day { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) => item is MessageItem m
        ? m.Side switch { MessageSide.Outgoing => Outgoing, MessageSide.System => System, MessageSide.Day => Day, _ => Incoming }
        : Incoming;

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}

/// <summary>Colleague chat: mine on the trailing edge, theirs on the leading edge.</summary>
public sealed partial class TeamMessageTemplateSelector : DataTemplateSelector
{
    public DataTemplate? Incoming { get; set; }
    public DataTemplate? Outgoing { get; set; }
    public DataTemplate? Day { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) =>
        item is TeamMessageItem t ? t.Side switch { MessageSide.Outgoing => Outgoing, MessageSide.Day => Day, _ => Incoming } : Incoming;

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}
