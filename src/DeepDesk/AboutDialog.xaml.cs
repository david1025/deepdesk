using System.Windows;

namespace DeepDesk;

public partial class AboutDialog : Window
{
    private double _ownerOpacity = 1.0;
    private bool _ownerWasDimmed;

    public AboutDialog()
    {
        InitializeComponent();
        VersionText.Text = $"版本 {UpdateService.CurrentVersion}";
    }

    protected override void OnContentRendered(EventArgs e)
    {
        base.OnContentRendered(e);

        if (Owner is not null && !_ownerWasDimmed)
        {
            _ownerOpacity = Owner.Opacity;
            Owner.Opacity = 0.68;
            _ownerWasDimmed = true;
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        if (Owner is not null && _ownerWasDimmed)
        {
            Owner.Opacity = _ownerOpacity;
            _ownerWasDimmed = false;
        }

        base.OnClosed(e);
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}
