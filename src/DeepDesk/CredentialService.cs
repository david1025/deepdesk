using System.Security.Cryptography;
using System.Text;

namespace DeepDesk;

internal sealed class CredentialService
{
    public bool Exists => File.Exists(AppPaths.ApiKeyFile);

    public void SaveApiKey(string apiKey)
    {
        if (string.IsNullOrWhiteSpace(apiKey) || apiKey.Length > 512)
            throw new ArgumentException("API Key 格式无效。");
        Directory.CreateDirectory(AppPaths.CredentialsDirectory);
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(apiKey.Trim()), null,
            DataProtectionScope.CurrentUser);
        File.WriteAllBytes(AppPaths.ApiKeyFile, encrypted);
    }

    public string ReadApiKey()
    {
        if (!Exists) throw new InvalidOperationException("请先配置 DeepSeek API Key。");
        var encrypted = File.ReadAllBytes(AppPaths.ApiKeyFile);
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(encrypted, null,
            DataProtectionScope.CurrentUser));
    }

    public void Clear()
    {
        if (Exists) File.Delete(AppPaths.ApiKeyFile);
    }
}
