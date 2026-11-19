using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace DeepDesk;

public partial class FirstRunDialog : Window
{
    private readonly CredentialService _credentials;
    private readonly DeepSeekApiService _api;
    private bool _isSaving;

    public FirstRunDialog(CredentialService credentials, DeepSeekApiService api)
    {
        InitializeComponent();
        _credentials = credentials;
        _api = api;
        Loaded += (_, _) => ApiKeyBox.Focus();
    }

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed)
            DragMove();
    }

    private void Close_Click(object sender, RoutedEventArgs e)
    {
        if (!_isSaving)
            DialogResult = false;
    }

    private void Skip_Click(object sender, RoutedEventArgs e)
    {
        if (!_isSaving)
            DialogResult = false;
    }

    private void OpenApiPortal_Click(object sender, RoutedEventArgs e)
    {
        Process.Start(new ProcessStartInfo("https://platform.deepseek.com/api_keys") { UseShellExecute = true });
    }

    private void ApiKeyBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        KeyPlaceholder.Visibility = string.IsNullOrEmpty(ApiKeyBox.Password)
            ? Visibility.Visible
            : Visibility.Collapsed;
        StatusText.Text = "";
    }

    private void ApiKeyBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && SaveButton.IsEnabled)
        {
            e.Handled = true;
            _ = SaveAsync();
        }
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
    {
        await SaveAsync();
    }

    private async Task SaveAsync()
    {
        if (_isSaving)
            return;

        var value = ApiKeyBox.Password.Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            StatusText.Text = "请先输入 API Key。";
            ApiKeyBox.Focus();
            return;
        }

        _isSaving = true;
        SaveButton.IsEnabled = false;
        SkipButton.IsEnabled = false;
        CloseButton.IsEnabled = false;
        SaveButton.Content = "正在验证…";
        StatusText.Foreground = new SolidColorBrush(Color.FromRgb(49, 94, 251));
        StatusText.Text = "正在连接 DeepSeek 验证密钥，请稍候…";

        try
        {
            await _api.TestKeyAsync(value, CancellationToken.None);
            _credentials.SaveApiKey(value);
            DialogResult = true;
        }
        catch (Exception ex)
        {
            StatusText.Foreground = new SolidColorBrush(Color.FromRgb(217, 45, 32));
            StatusText.Text = string.IsNullOrWhiteSpace(ex.Message)
                ? "验证失败，请检查 API Key 和网络连接后重试。"
                : ex.Message;
            ApiKeyBox.Focus();
        }
        finally
        {
            _isSaving = false;
            if (IsVisible)
            {
                SaveButton.IsEnabled = true;
                SkipButton.IsEnabled = true;
                CloseButton.IsEnabled = true;
                SaveButton.Content = "验证并开始使用";
            }
        }
    }
}
