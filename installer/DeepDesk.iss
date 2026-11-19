#define MyAppName "DeepDesk"
#define MyAppVersion "0.2.0"
#define MyAppDisplayVersion "0.2.0 Preview 1"
#define MyAppPublisher "DeepDesk Contributors"
#define MyAppExeName "DeepDesk.exe"

[Setup]
; AppId is deliberately stable: newer installers upgrade the existing per-user install.
AppId={{A34E6F7D-8B1B-4C6F-A4E5-5F4E7B1A9C21}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppDisplayVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/david1025/deepdesk
AppSupportURL=https://github.com/david1025/deepdesk/issues
DefaultDirName={localappdata}\Programs\DeepDesk
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\artifacts\installer
OutputBaseFilename=DeepDesk-Setup-0.2.0-preview.1-x64
ArchitecturesInstallIn64BitMode=x64
ArchitecturesAllowed=x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
Uninstallable=yes
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
; This is a preview build, unsigned until a code-signing certificate is available.

[Files]
; Install the complete published app, including WebView2 runtime loader and UI assets.
; Never place profiles, encryption keys, chats or downloaded files here.
Source: "..\artifacts\DeepDesk-win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: postinstall nowait skipifsilent

; There is deliberately no [UninstallDelete] directive for LocalAppData.
; %LOCALAPPDATA%\DeepDesk\WebView2, credentials, settings and logs survive upgrades
; and uninstallation. Never delete those directories from the installer.
