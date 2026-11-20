using System.Runtime.InteropServices;
using System.Windows;

namespace DeepDesk;

public partial class App : Application
{
    // Keep the process identity aligned with the installer shortcuts so Windows
    // groups the running window with the correct DeepDesk taskbar icon.
    private const string AppUserModelId = "com.david.deepdesk";

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(
        [MarshalAs(UnmanagedType.LPWStr)] string appId);

    protected override void OnStartup(StartupEventArgs e)
    {
        _ = SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
        base.OnStartup(e);
    }
}
