using System.Text.RegularExpressions;

namespace Webyar.Core.Inbox;

/// <summary>
/// A received e-mail's HTML with everything that is not drawing taken out,
/// as Android's EmailReader.sanitize does: no scripts, frames, plugins,
/// forms, <c>&lt;meta&gt;</c> or <c>&lt;base&gt;</c>, no event attributes and
/// no <c>javascript:</c> links. Scripts are off in the reader's WebView2, so
/// this is the second fence: it keeps a mail from bringing a form, a frame
/// onto some other page, or a <c>&lt;meta refresh&gt;</c> that navigates on
/// its own. Styles and pictures stay.
/// </summary>
public static partial class MailHtml
{
    [GeneratedRegex(@"<(script|iframe|frameset|frame|object|applet|noembed|textarea|select|template|title|noscript)\b[^>]*>.*?</\1\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex DropWithContent();

    [GeneratedRegex(@"</?(script|iframe|frameset|frame|object|applet|embed|meta|base|link|form|input|button|textarea|select|option|html|head|body|title|xmp|plaintext|noscript|portal)\b[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex DropTag();

    [GeneratedRegex(@"<!doctype[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex Doctype();

    [GeneratedRegex(@"[\s/]+on[a-z]+\s*=\s*(""[^""]*""|'[^']*'|[^\s>]+)", RegexOptions.IgnoreCase)]
    private static partial Regex EventAttribute();

    [GeneratedRegex(@"(href|src|action|formaction|xlink:href)\s*=\s*([""']?)\s*(javascript|vbscript|data:text/html)[^""'\s>]*\2", RegexOptions.IgnoreCase)]
    private static partial Regex ScriptUrl();

    [GeneratedRegex(@"<style\b", RegexOptions.IgnoreCase)]
    private static partial Regex StyleOpen();

    public static string Sanitize(string html)
    {
        var output = DropWithContent().Replace(html ?? string.Empty, string.Empty);
        // An unclosed <style> would read the rest of the page as CSS, an
        // unclosed comment would hide it: the first is cut, the second closed.
        var opens = StyleOpen().Matches(output);
        if (opens.Count > 0)
        {
            var last = opens[^1].Index;
            if (output.IndexOf("</style", last, StringComparison.OrdinalIgnoreCase) < 0) output = output[..last];
        }
        if (output.LastIndexOf("<!--", StringComparison.Ordinal) > output.LastIndexOf("-->", StringComparison.Ordinal)) output += "-->";
        output = Doctype().Replace(output, string.Empty);
        output = DropTag().Replace(output, string.Empty);
        output = EventAttribute().Replace(output, string.Empty);
        output = ScriptUrl().Replace(output, m => $"{m.Groups[1].Value}=\"#\"");
        return output;
    }
}
