using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Webyar.App.Services;

/// <summary>
/// "Remember me" on the sign-in page: the email and password, encrypted with
/// DPAPI for this Windows user (like the session token), so they fill in by
/// themselves after a sign-out. Nothing leaves the PC.
/// </summary>
public static class SavedLogin
{
    private static readonly byte[] Entropy = "Webyar.Login.v1"u8.ToArray();
    private static string PathOf => Path.Combine(AppPaths.Data, "login.bin");

    public sealed record Credentials(string Email, string Password);

    public static Credentials? Read()
    {
        try
        {
            if (!File.Exists(PathOf)) return null;
            var json = ProtectedData.Unprotect(File.ReadAllBytes(PathOf), Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<Credentials>(Encoding.UTF8.GetString(json));
        }
        catch (Exception e) when (e is CryptographicException or IOException or JsonException)
        {
            Log.Error("read saved login", e);
            return null;
        }
    }

    public static void Write(string email, string password)
    {
        try
        {
            var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Credentials(email, password)));
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
