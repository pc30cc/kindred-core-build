using Webyar.Core.Inbox;
using Xunit;

namespace Webyar.Core.Tests;

/// <summary>
/// The e-mail reader's HTML fence (MailHtml), the same cases as Android's
/// EmailReaderTest: nothing in a mail may navigate, post or run on its own.
/// </summary>
public class MailHtmlTests
{
    [Fact]
    public void DropsEverythingThatIsNotDrawing()
    {
        const string mail = """
            <!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/a.css"></head>
            <body onload="steal()"><p style="color:red">Hello <a href="javascript:steal()">here</a></p><img src=x onerror=steal()><svg/onload=steal()>
            <script>steal()</script><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="p"><button>Go</button></form>
            <object data="x"></object><embed src="x"></body></html>
            """;
        var clean = MailHtml.Sanitize(mail);
        foreach (var bad in new[] { "<script", "steal()", "<iframe", "<form", "<input", "<button", "<meta", "<base", "<link", "<object", "<embed", "onload", "onerror", "onclick", "javascript:", "<!doctype", "<html", "<body" })
            Assert.DoesNotContain(bad, clean, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("<p style=\"color:red\">Hello <a href=\"#\">here</a></p>", clean);
        Assert.Contains("<img src=x>", clean);
    }

    [Fact]
    public void ACutOffMailDoesNotSwallowThePage()
    {
        Assert.Equal("<p>a</p>", MailHtml.Sanitize("<p>a</p><style>p{color:red}"));
        Assert.Equal("<p>a</p><!-- open-->", MailHtml.Sanitize("<p>a</p><!-- open"));
        Assert.Equal("<style>p{}</style><p>b</p>", MailHtml.Sanitize("<style>p{}</style><p>b</p>"));
    }

    [Fact]
    public void KeepsLinksAndPictures()
    {
        const string mail = "<a href=\"https://example.com/x?a=1\">x</a><img src=\"https://example.com/p.png\" width=\"20\">";
        Assert.Equal(mail, MailHtml.Sanitize(mail));
    }
}
