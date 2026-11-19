using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Webyar.App.Services;

/// <summary>
/// "Remember me" on the sign-in page: the email only, encrypted with DPAPI
/// for this Windows user, so it fills in by itself after a sign-out. The
/// password is never kept: the session token (DpapiSessionStore) is what keeps
/// the user signed in, and a stored password could be read back by any
/// program running as the same Windows user. Nothing leaves the PC.
/// </summary>
public static class SavedLogin
{
    private static readonly byte[] Entropy = "Webyar.Login.v1"u8.ToArray();
    private static string PathOf => Path.Combine(AppPaths.Data, "login.bin");

    public sealed record Credentials(string Email);

    /// <summary>What an older version wrote: the email and the password.</summary>
    private sealed record LegacyCredentials(string? Email, string? Password);

    public static Credentials? Read()
    {
        try
        {
            if (!File.Exists(PathOf)) return null;
            var json = ProtectedData.Unprotect(File.ReadAllBytes(PathOf), Entropy, DataProtectionScope.CurrentUser);
            var saved = JsonSerializer.Deserialize<LegacyCredentials>(Encoding.UTF8.GetString(json));
            if (saved is null || string.IsNullOrWhiteSpace(saved.Email)) return null;
            // A file from an older version still holds the password: rewrite
            // it with the email alone the first time it is read.
            if (!string.IsNullOrEmpty(saved.Password)) Write(saved.Email);
            return new Credentials(saved.Email);
        }
        catch (Exception e) when (e is CryptographicException or IOException or JsonException)
        {
            Log.Error("read saved login", e);
            return null;
        }
    }

    public static void Write(string email)
    {
        try
        {
            var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Credentials(email)));
            File.WriteAllBytes(PathOf, ProtectedData.Protect(json, Entropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception e) when (e is CryptographicException or IOException)
        {
            Log.Error("write saved login", e);
        }
    }

    public static void Forget()
    {
        try
        {
            if (File.Exists(PathOf)) File.Delete(PathOf);
        }
        catch (IOException)
        {
        }
    }
}
