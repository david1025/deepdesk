using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace DeepDesk;

public partial class FirstRunDialog : Window
{
    private readonly CredentialService _credentials;
    private readonly DeepSeekApiService _api;
    private readonly bool _hasExistingKey;
    private bool _isSaving;

    internal FirstRunDialog(CredentialService credentials, DeepSeekApiService api)
    {
        InitializeComponent();
        _credentials = credentials;
        _api = api;
        _hasExistingKey = credentials.Exists;

        if (_hasExistingKey)
        {
            KeyEntryPanel.Visibility = Visibility.Collapsed;
            ExistingKeyPanel.Visibility = Visibility.Visible;
            ContinueButton.Content = "继续";
        }

        Loaded += (_, _) =>
        {
            if (!_hasExistingKey)
                ApiKeyBox.Focus();
        };
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

    private void OpenApiPortal_Click(object sender, RoutedEventArgs e)
    {
        OpenExternal("https://platform.deepseek.com/api_keys");
    }

    private void OpenDeepSeek_Click(object sender, RoutedEventArgs e)
    {
        OpenExternal("https://chat.deepseek.com/");
    }

    private void ApiKeyBox_PasswordChanged(object sender, RoutedEventArgs e)
    {
        KeyPlaceholder.Visibility = string.IsNullOrEmpty(ApiKeyBox.Password)
            ? Visibility.Visible
            : Visibility.Collapsed;
        StatusText.Text = "";
        if (!_hasExistingKey)
            ContinueButton.Content = string.IsNullOrWhiteSpace(ApiKeyBox.Password) ? "继续" : "验证并继续";
    }

    private void ApiKeyBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && ContinueButton.IsEnabled)
        {
            e.Handled = true;
            _ = ContinueAsync();
        }
    }

    private void Continue_Click(object sender, RoutedEventArgs e)
    {
        _ = ContinueAsync();
    }

    private void Skip_Click(object sender, RoutedEventArgs e)
    {
        if (!_isSaving)
            ShowStepTwo();
    }

    private void Back_Click(object sender, RoutedEventArgs e)
    {
        if (!_isSaving)
            ShowStepOne();
    }

    private void Finish_Click(object sender, RoutedEventArgs e)
    {
        if (!_isSaving)
            DialogResult = true;
    }

    private void ShowStepOne()
    {
        StepOnePanel.Visibility = Visibility.Visible;
        StepTwoPanel.Visibility = Visibility.Collapsed;
        StepOneActions.Visibility = Visibility.Visible;
        StepTwoActions.Visibility = Visibility.Collapsed;
        FooterHint.Text = "API Key 不是必填项，可以稍后配置。";
        if (!_hasExistingKey)
            ApiKeyBox.Focus();
    }

    private void ShowStepTwo()
    {
        StepOnePanel.Visibility = Visibility.Collapsed;
        StepTwoPanel.Visibility = Visibility.Visible;
        StepOneActions.Visibility = Visibility.Collapsed;
        StepTwoActions.Visibility = Visibility.Visible;
        FooterHint.Text = "历史对话可以随时从设置中导入。";
    }

    private async Task ContinueAsync()
    {
        if (_isSaving)
            return;

        if (_hasExistingKey || string.IsNullOrWhiteSpace(ApiKeyBox.Password))
        {
            ShowStepTwo();
            return;
        }

        _isSaving = true;
        ContinueButton.IsEnabled = false;
        SkipButton.IsEnabled = false;
        CloseButton.IsEnabled = false;
        ContinueButton.Content = "正在验证…";
        StatusText.Foreground = new SolidColorBrush(Color.FromRgb(49, 94, 251));
        StatusText.Text = "正在连接 DeepSeek 验证密钥，请稍候…";

        try
        {
            await _api.TestKeyAsync(ApiKeyBox.Password.Trim(), CancellationToken.None);
            _credentials.SaveApiKey(ApiKeyBox.Password.Trim());
            ShowStepTwo();
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
                ContinueButton.IsEnabled = true;
                SkipButton.IsEnabled = true;
                CloseButton.IsEnabled = true;
                ContinueButton.Content = _hasExistingKey || string.IsNullOrWhiteSpace(ApiKeyBox.Password)
                    ? "继续" : "验证并继续";
            }
        }
    }

    private static void OpenExternal(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
