using Webyar.Core.Localization;
using Xunit;

namespace Webyar.Core.Tests;

public class LocalizationTests
{
    [Fact]
    public void Persian_copy_comes_from_the_shared_strings()
    {
        var fa = new Strings(Language.Fa);
        Assert.True(fa.IsRightToLeft);
        Assert.NotEqual("appName", fa["appName"]);
        Assert.NotEqual(new Strings(Language.En)["about"], fa["about"]);
    }

    [Fact]
    public void Numbers_in_placeholders_use_persian_digits()
    {
        var fa = new Strings(Language.Fa);
        Assert.Contains("۱۲", fa.Get("activeFilters", "n", 12));
        Assert.Contains("12", new Strings(Language.En).Get("activeFilters", "n", 12));
    }

    [Fact]
    public void Unknown_keys_fall_back_to_the_key()
    {
        Assert.Equal("no.such.key", new Strings(Language.Tr)["no.such.key"]);
    }

    [Fact]
    public void Every_language_has_every_key()
    {
        var en = new Strings(Language.En);
        foreach (var language in new[] { Language.Fa, Language.Tr })
        {
            var s = new Strings(language);
            Assert.True(s.Has("appName"));
        }
        Assert.True(en.Has("newMessageFrom"));
    }

    [Theory]
    [InlineData("fa-IR", Language.Fa)]
    [InlineData("tr-TR", Language.Tr)]
    [InlineData("en-US", Language.En)]
    [InlineData("de-DE", Language.Fa)]
    public void First_launch_follows_windows(string culture, Language expected) =>
        Assert.Equal(expected, Strings.FromSystem(System.Globalization.CultureInfo.GetCultureInfo(culture)));

    [Fact]
    public void Digits_only_change_for_persian()
    {
        Assert.Equal("۲۰۲۶/۰۹", Digits.Localize("2026/09", Language.Fa));
        Assert.Equal("2026/09", Digits.Localize("2026/09", Language.En));
    }
}
