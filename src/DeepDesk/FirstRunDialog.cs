using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace DeepDesk;

internal sealed class FirstRunDialog : Window
{
    private readonly CredentialService _credentials;
    private readonly DeepSeekApiService _api;
    private readonly PasswordBox _key = new();
    private readonly TextBlock _status = new();
    private readonly Button _save = new();

    public FirstRunDialog(CredentialService credentials, DeepSeekApiService api)
    {
        _credentials = credentials;
        _api = api;
        Title = "欢迎使用 DeepDesk";
        Width = 520;
        Height = 390;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Background = Brushes.White;
        ShowInTaskbar = false;

        var panel = new StackPanel { Margin = new Thickness(30) };
        panel.Children.Add(new TextBlock { Text = "欢迎使用 DeepDesk", FontSize = 25, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(32, 41, 56)) });
        panel.Children.Add(new TextBlock { Text = "本地运行，数据保存在这台电脑。使用前需要配置你自己的 DeepSeek API Key。", TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 22), Foreground = Brushes.Gray });
        panel.Children.Add(new TextBlock { Text = "1. 在 DeepSeek 开放平台创建 API Key", FontSize = 14, Margin = new Thickness(0, 0, 0, 8) });
        var link = new TextBlock { Text = "https://platform.deepseek.com/api_keys", Foreground = new SolidColorBrush(Color.FromRgb(37, 99, 235)), Cursor = System.Windows.Input.Cursors.Hand, Margin = new Thickness(0, 0, 0, 18) };
        link.MouseLeftButtonUp += (_, _) => System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://platform.deepseek.com/api_keys") { UseShellExecute = true });
        panel.Children.Add(link);
        panel.Children.Add(new TextBlock { Text = "2. 粘贴 API Key（仅在本机加密保存）", Margin = new Thickness(0, 0, 0, 8) });
        _key.Height = 38;
        _key.Padding = new Thickness(9);
        panel.Children.Add(_key);
        _status.Margin = new Thickness(0, 10, 0, 0);
        _status.Foreground = Brushes.Firebrick;
        _status.TextWrapping = TextWrapping.Wrap;
        panel.Children.Add(_status);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 22, 0, 0) };
        var skip = new Button { Content = "稍后配置", Width = 94, Height = 34, Margin = new Thickness(0, 0, 10, 0) };
        skip.Click += (_, _) => { DialogResult = false; };
        _save.Content = "验证并保存";
        _save.Width = 110;
        _save.Height = 34;
        _save.IsDefault = true;
        _save.Click += async (_, _) => await SaveAsync();
        actions.Children.Add(skip);
        actions.Children.Add(_save);
        panel.Children.Add(actions);
        Content = panel;
        Loaded += (_, _) => _key.Focus();
    }

    private async Task SaveAsync()
    {
        var value = _key.Password.Trim();
        if (string.IsNullOrWhiteSpace(value))
        {
            _status.Text = "请先输入 API Key。";
            return;
        }
        _save.IsEnabled = false;
        _save.Content = "正在验证…";
        _status.Text = "";
        try
        {
            await _api.TestKeyAsync(value, CancellationToken.None);
            _credentials.SaveApiKey(value);
            DialogResult = true;
        }
        catch (Exception ex)
        {
            _status.Text = ex.Message;
        }
        finally
        {
            if (IsVisible)
            {
                _save.IsEnabled = true;
                _save.Content = "验证并保存";
            }
        }
    }
}
