using System.Windows;

namespace DeepDesk;

public partial class AboutDialog : Window
{
    public AboutDialog()
    {
        InitializeComponent();
        VersionText.Text = $"版本 {UpdateService.CurrentVersion}";
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
