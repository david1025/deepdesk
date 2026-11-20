using System.Windows;

namespace DeepDesk;

public partial class UpdateDialog : Window
{
    public UpdateDialog(string status, string message, string detail, string primaryText = "确定")
    {
        InitializeComponent();
        StatusText.Text = status;
        MessageText.Text = message;
        DetailText.Text = detail;
        PrimaryButton.Content = primaryText;
    }

    private void Close_Click(object sender, RoutedEventArgs e) => DialogResult = false;
    private void Confirm_Click(object sender, RoutedEventArgs e) => DialogResult = true;
}
