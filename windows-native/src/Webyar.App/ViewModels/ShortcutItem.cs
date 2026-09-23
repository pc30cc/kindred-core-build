using Webyar.Core.Api;
using Webyar.Core.Inbox;

namespace Webyar.App.ViewModels;

/// <summary>A saved reply in the "/" picker.</summary>
public sealed class ShortcutItem(CannedResponse c)
{
    public CannedResponse Response { get; } = c;
    public string Title => Response.Title;
    public string Shortcut => "/" + Response.Shortcut;
    public string Preview => Display.OneLine(Response.Body);
}
