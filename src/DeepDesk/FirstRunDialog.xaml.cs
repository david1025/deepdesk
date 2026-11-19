using Microsoft.Win32;
using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using System.Text.Json;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace DeepDesk;

public partial class FirstRunDialog : Window
{
    private const long MaxHistoryArchiveBytes = 512L * 1024 * 1024;
    private const int TransferChunkSize = 512 * 1024;

    private readonly CredentialService _credentials;
    private readonly DeepSeekApiService _api;
    private readonly CoreWebView2 _web;
    private readonly bool _hasExistingKey;
    private bool _isSaving;
    private bool _isImportingHistory;
    private string? _selectedHistoryPath;

    private sealed record HistoryImportResult(int Imported, int Skipped);

    internal FirstRunDialog(CredentialService credentials, DeepSeekApiService api, CoreWebView2 web)
    {
        InitializeComponent();
        _credentials = credentials;
        _api = api;
        _web = web;
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
        if (!_isSaving && !_isImportingHistory)
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
        if (!_isSaving && !_isImportingHistory)
            ShowStepOne();
    }

    private void SkipImport_Click(object sender, RoutedEventArgs e)
    {
        if (!_isImportingHistory)
            DialogResult = true;
    }

    private void Finish_Click(object sender, RoutedEventArgs e)
    {
        if (!_isImportingHistory && FinishButton.IsEnabled)
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
        FooterHint.Text = "选择 ZIP 文件后即可在这里直接导入，也可以跳过。";
    }

    private void ChooseHistoryFile_Click(object sender, RoutedEventArgs e)
    {
        if (_isImportingHistory)
            return;

        var dialog = new OpenFileDialog
        {
            Title = "选择 DeepSeek 历史数据",
            Filter = "DeepSeek 历史数据 (*.zip)|*.zip|ZIP 文件 (*.zip)|*.zip",
            CheckFileExists = true,
            Multiselect = false
        };

        if (dialog.ShowDialog(this) != true)
            return;

        var info = new FileInfo(dialog.FileName);
        _selectedHistoryPath = info.FullName;
        HistoryFileNameText.Text = info.Name;
        HistoryFileMetaText.Text = $"{FormatFileSize(info.Length)} · ZIP 历史数据文件";
        HistoryStatusText.Foreground = new SolidColorBrush(Color.FromRgb(102, 112, 133));
        HistoryStatusText.Text = "文件已选择。点击「开始导入」后，将历史对话导入到本机。";
        HistoryProgressBar.Visibility = Visibility.Collapsed;
        HistoryProgressBar.IsIndeterminate = false;
        HistoryProgressBar.Value = 0;
        ImportHistoryButton.IsEnabled = true;
        FinishButton.IsEnabled = false;
    }

    private async void ImportHistory_Click(object sender, RoutedEventArgs e)
    {
        if (_isImportingHistory || string.IsNullOrWhiteSpace(_selectedHistoryPath))
            return;

        var path = _selectedHistoryPath;
        var info = new FileInfo(path);
        if (!info.Exists || info.Length == 0)
        {
            SetHistoryError("文件不存在或为空，请重新选择 ZIP 文件。");
            return;
        }
        if (info.Length > MaxHistoryArchiveBytes)
        {
            SetHistoryError("文件超过 512 MB，请选择较小的 DeepSeek 历史数据 ZIP 文件。");
            return;
        }

        _isImportingHistory = true;
        ChooseHistoryFileButton.IsEnabled = false;
        ImportHistoryButton.IsEnabled = false;
        BackButton.IsEnabled = false;
        SkipImportButton.IsEnabled = false;
        CloseButton.IsEnabled = false;
        FinishButton.IsEnabled = false;
        HistoryProgressBar.Visibility = Visibility.Visible;
        HistoryProgressBar.IsIndeterminate = false;
        HistoryProgressBar.Value = 0;
        HistoryStatusText.Foreground = new SolidColorBrush(Color.FromRgb(71, 84, 103));
        HistoryStatusText.Text = "正在读取 ZIP 文件…";

        try
        {
            var beginScript = $"Boolean(window.deepDeskHistoryImport && window.deepDeskHistoryImport.begin({JsonSerializer.Serialize(info.Name)},{info.Length}))";
            var beginResult = await _web.ExecuteScriptAsync(beginScript);
            if (!string.Equals(beginResult.Trim(), "true", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("DeepDesk 导入组件尚未就绪，请稍后重试。");

            await using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read,
                TransferChunkSize, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                var buffer = new byte[TransferChunkSize];
                long transferred = 0;
                int read;
                while ((read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length))) > 0)
                {
                    var base64 = Convert.ToBase64String(buffer, 0, read);
                    await _web.ExecuteScriptAsync(
                        $"window.deepDeskHistoryImport.append({JsonSerializer.Serialize(base64)});");
                    transferred += read;
                    var percent = (int)Math.Min(90, Math.Round((double)transferred / info.Length * 90));
                    HistoryProgressBar.Value = percent;
                    HistoryStatusText.Text = $"正在准备导入… {percent}%";
                }
            }

            HistoryProgressBar.IsIndeterminate = true;
            HistoryStatusText.Text = "文件已就绪，正在校验 ZIP 并导入历史会话，请稍候…";

            var completion = new TaskCompletionSource<HistoryImportResult>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler<CoreWebView2WebMessageReceivedEventArgs>? resultHandler = null;
            resultHandler = (_, args) =>
            {
                if (!Uri.TryCreate(args.Source, UriKind.Absolute, out var source) ||
                    source.Scheme != "https" || source.Host != "deepdesk.local")
                    return;

                try
                {
                    using var document = JsonDocument.Parse(args.WebMessageAsJson);
                    var root = document.RootElement;
                    if (!root.TryGetProperty("type", out var type) ||
                        type.GetString() != "deepdesk-history-import-result")
                        return;

                    if (root.TryGetProperty("success", out var success) && success.GetBoolean())
                    {
                        var result = root.GetProperty("result");
                        completion.TrySetResult(new HistoryImportResult(
                            result.GetProperty("imported").GetInt32(),
                            result.GetProperty("skipped").GetInt32()));
                    }
                    else
                    {
                        var message = root.TryGetProperty("error", out var error)
                            ? error.GetString() : null;
                        completion.TrySetException(new InvalidDataException(
                            string.IsNullOrWhiteSpace(message) ? "导入失败，请检查 ZIP 文件是否完整。" : message));
                    }
                }
                catch (Exception ex)
                {
                    completion.TrySetException(ex);
                }
            };

            _web.WebMessageReceived += resultHandler;
            try
            {
                await _web.ExecuteScriptAsync("window.deepDeskHistoryImport.finish();");
                var result = await completion.Task.WaitAsync(TimeSpan.FromMinutes(10));
                HistoryProgressBar.Visibility = Visibility.Collapsed;
                HistoryProgressBar.IsIndeterminate = false;
                HistoryStatusText.Foreground = new SolidColorBrush(Color.FromRgb(39, 117, 72));
                HistoryStatusText.Text = $"导入完成：新增 {result.Imported} 个会话，跳过 {result.Skipped} 个已存在的会话。";
                FinishButton.IsEnabled = true;
                ImportHistoryButton.Content = "再次导入";
            }
            finally
            {
                _web.WebMessageReceived -= resultHandler;
            }
        }
        catch (Exception ex)
        {
            try { await _web.ExecuteScriptAsync("window.deepDeskHistoryImport?.cancel();"); } catch { }
            HistoryProgressBar.Visibility = Visibility.Collapsed;
            HistoryProgressBar.IsIndeterminate = false;
            SetHistoryError(string.IsNullOrWhiteSpace(ex.Message) ? "导入失败，请重试。" : ex.Message);
        }
        finally
        {
            _isImportingHistory = false;
            if (IsVisible)
            {
                ChooseHistoryFileButton.IsEnabled = true;
                ImportHistoryButton.IsEnabled = !string.IsNullOrWhiteSpace(_selectedHistoryPath);
                BackButton.IsEnabled = true;
                SkipImportButton.IsEnabled = true;
                CloseButton.IsEnabled = true;
            }
        }
    }

    private void SetHistoryError(string message)
    {
        HistoryStatusText.Foreground = new SolidColorBrush(Color.FromRgb(217, 45, 32));
        HistoryStatusText.Text = message;
        FinishButton.IsEnabled = false;
    }

    private static string FormatFileSize(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024d:0.#} KB";
        return $"{bytes / (1024d * 1024d):0.#} MB";
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
