using Microsoft.Win32;
using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace DeepDesk;

public partial class AboutDialog : Window
{
    private const string RepositoryUrl = "https://github.com/david1025/deepdesk";

    public AboutDialog()
    {
        InitializeComponent();
        VersionText.Text = $"版本 {UpdateService.CurrentVersion}";
        ApplyWindowsTheme();
    }

    private static bool IsWindowsLightTheme()
    {
        try
        {
            var value = Registry.GetValue(
                @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
                "AppsUseLightTheme", 1);
            return Convert.ToInt32(value) != 0;
        }
        catch
        {
            return true;
        }
    }

    private void ApplyWindowsTheme()
    {
        var light = IsWindowsLightTheme();
        var palette = light
            ? new Dictionary<string, string>
            {
                ["WindowBrush"] = "#FFFFFF",
                ["HeaderBrush"] = "#FFFFFF",
                ["CardBrush"] = "#F8FAFC",
                ["BorderBrush"] = "#E5E9F0",
                ["TextBrush"] = "#202938",
                ["MutedBrush"] = "#7B8494",
                ["HoverBrush"] = "#F0F3F8",
                ["AccentBrush"] = "#315EFB",
                ["IconBackgroundBrush"] = "#EEF3FF",
                ["StatusBrush"] = "#EAF7EF",
                ["StatusTextBrush"] = "#287548"
            }
            : new Dictionary<string, string>
            {
                ["WindowBrush"] = "#1D2028",
                ["HeaderBrush"] = "#20242D",
                ["CardBrush"] = "#272C37",
                ["BorderBrush"] = "#363D49",
                ["TextBrush"] = "#F2F4F7",
                ["MutedBrush"] = "#A0A8B5",
                ["HoverBrush"] = "#303744",
                ["AccentBrush"] = "#9DB4FF",
                ["IconBackgroundBrush"] = "#293653",
                ["StatusBrush"] = "#20392D",
                ["StatusTextBrush"] = "#9AD5AE"
            };

        foreach (var item in palette)
        {
            var color = (Color)ColorConverter.ConvertFromString(item.Value);
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            Resources[item.Key] = brush;
        }
    }

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed)
            DragMove();
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private static void GitHub_Click(object sender, RoutedEventArgs e)
    {
        Process.Start(new ProcessStartInfo(RepositoryUrl) { UseShellExecute = true });
    }
}