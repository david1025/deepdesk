using System.Windows;

namespace DeepDesk;

public partial class ApiKeyDialog : Window
{
    public string ApiKey { get; private set; } = "";

    public ApiKeyDialog()
    {
        InitializeComponent();
        Loaded += (_, _) => KeyBox.Focus();
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(KeyBox.Password))
        {
            MessageBox.Show(this, "请输入 API Key。", "DeepDesk", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        ApiKey = KeyBox.Password.Trim();
        DialogResult = true;
    }
}
