#define MyAppName "DeepDesk"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "DeepDesk Contributors"
#define MyAppExeName "DeepDesk.exe"

[Setup]
AppId={{A34E6F7D-8B1B-4C6F-A4E5-5F4E7B1A9C21}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\DeepDesk
DefaultGroupName={#MyAppName}
OutputDir=..\artifacts
OutputBaseFilename=DeepDesk-Setup-{#MyAppVersion}-x64
ArchitecturesInstallIn64BitMode=x64
ArchitecturesAllowed=x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
Uninstallable=yes

[Files]
Source: "..\src\DeepDesk\bin\Release\net10.0-windows\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; Intentionally do not remove %LOCALAPPDATA%\DeepDesk so user data survives uninstall.
