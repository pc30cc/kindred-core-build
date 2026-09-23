using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Webyar.App.ViewModels;

namespace Webyar.App.Helpers;

/// <summary>Visitor bubbles on the leading edge, the team's on the trailing edge, notices in the middle.</summary>
public sealed partial class MessageTemplateSelector : DataTemplateSelector
{
    public DataTemplate? Incoming { get; set; }
    public DataTemplate? Outgoing { get; set; }
    public DataTemplate? System { get; set; }

    protected override DataTemplate? SelectTemplateCore(object item) => item is MessageItem m
        ? m.Side switch { MessageSide.Outgoing => Outgoing, MessageSide.System => System, _ => Incoming }
        : Incoming;

    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}
