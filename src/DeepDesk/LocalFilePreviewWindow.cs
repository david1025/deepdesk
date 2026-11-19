using Microsoft.Web.WebView2.Wpf;
using System.Windows;

namespace DeepDesk;

/// <summary>
/// Dedicated local attachment preview. Reuses the parent WebView2 environment
/// so blob: URLs created in the chat page resolve in the popup's profile.
/// </summary>
internal sealed class LocalFilePreviewWindow : Window
{
    public WebView2 Browser { get; } = new();

    public LocalFilePreviewWindow(Window owner)
    {
        Owner = owner;
        Title = "DeepDesk 文件预览";
        Width = 920;
        Height = 700;
        MinWidth = 480;
        MinHeight = 320;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Content = Browser;
    }
}
