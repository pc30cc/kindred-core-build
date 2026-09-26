using System.Text.Json;
using Webyar.Core.Config;
using Xunit;

namespace Webyar.Core.Tests;

public class DesktopConfigTests
{
    private static DesktopConfig Parse(string json) => DesktopConfig.Parse(JsonDocument.Parse(json).RootElement);

    [Fact]
    public void Reads_the_super_admin_settings()
    {
        var c = Parse("""
        { "update": { "feedUrl": "https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download/", "channel": "beta",
                      "latestVersion": "2.1.0", "minimumSupportedVersion": "2.0.0", "autoUpdate": false, "checkIntervalMinutes": 60 },
          "realtime": { "enabled": false }, "polling": { "intervalSeconds": 20, "withRealtimeSeconds": 300 }, "features": { "calls": false } }
        """);
        Assert.Equal("https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download", c.Update.FeedUrl);
        Assert.Equal("beta", c.Update.Channel);
        Assert.False(c.Update.AutoUpdate);
        Assert.Equal(60, c.Update.CheckIntervalMinutes);
        Assert.False(c.RealtimeEnabled);
        Assert.Equal(20, c.PollIntervalSeconds);
        Assert.Equal(300, c.PollWithRealtimeSeconds);
        Assert.False(c.CallsEnabled);
    }

    [Fact]
    public void Bad_fields_fall_back_one_by_one()
    {
        var c = Parse("""{ "update": { "feedUrl": "http://insecure.example", "channel": "nightly", "checkIntervalMinutes": 1 }, "polling": { "intervalSeconds": "x" } }""");
        Assert.Null(c.Update.FeedUrl);
        Assert.Equal("stable", c.Update.Channel);
        Assert.Equal(15, c.Update.CheckIntervalMinutes);
        Assert.Equal(DesktopConfig.Defaults.PollIntervalSeconds, c.PollIntervalSeconds);
        Assert.True(c.RealtimeEnabled);
    }

    [Fact]
    public void An_empty_answer_is_the_defaults() => Assert.Equal(DesktopConfig.Defaults, Parse("{}"));

    [Theory]
    [InlineData("2.0.0", "2.1.0", true)]
    [InlineData("2.1.0", "2.1.0", false)]
    [InlineData("2.2.0", "2.1.0", false)]
    [InlineData("1.9.9", "v2.0.0-beta.1", true)]
    [InlineData("2.0.0", null, false)]
    [InlineData("2.0.0", "garbage", false)]
    public void Minimum_supported_version(string current, string? minimum, bool below)
    {
        var settings = DesktopConfig.Defaults.Update with { MinimumSupportedVersion = minimum };
        Assert.Equal(below, settings.IsBelowMinimum(Version.Parse(current)));
    }

    [Theory]
    [InlineData("native-v2.5.0", "2.5.0")]
    [InlineData("v2.5.1", "2.5.1")]
    [InlineData("2.5.1", "2.5.1")]
    [InlineData("V3.0", "3.0")]
    [InlineData("v2.6.0-beta.1", "2.6.0-beta.1")]
    [InlineData("native", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void A_release_tag_gives_its_version_wherever_it_sits(string? tag, string? expected)
    {
        Assert.Equal(expected, SemVer.FromTag(tag));
    }

    [Fact]
    public void A_newer_release_tag_is_newer_than_the_running_build()
    {
        // The Program Files update read "native-v2.5.0" as no version at all, and so never updated.
        Assert.True(SemVer.TryParse(SemVer.FromTag("native-v2.5.0"), out var latest));
        Assert.True(SemVer.TryParse("2.4.1+949fa16ef421295116421267bee9d759e3f28b6e", out var current));
        Assert.True(SemVer.Compare(latest, current) > 0);
    }
}
