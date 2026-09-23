using Windows.ApplicationModel.DataTransfer;

namespace Webyar.App.Helpers;

/// <summary>Plain text to the Windows clipboard, kept after the app closes.</summary>
public static class TextClipboard
{
    public static void Copy(string text)
    {
        var package = new DataPackage { RequestedOperation = DataPackageOperation.Copy };
        package.SetText(text ?? string.Empty);
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
        try { Windows.ApplicationModel.DataTransfer.Clipboard.Flush(); } catch { }
    }
}
