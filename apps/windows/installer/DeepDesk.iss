#define MyAppName "DeepDesk"
#define VersionFile FileOpen(AddBackslash(SourcePath) + "..\..\..\VERSION")
#define MyAppVersion FileRead(VersionFile)
#call FileClose(VersionFile)
#define PrereleaseSeparator Pos("-", MyAppVersion)
#if PrereleaseSeparator > 0
  #define NumericAppVersion Copy(MyAppVersion, 1, PrereleaseSeparator - 1)
#else
  #define NumericAppVersion MyAppVersion
#endif
#define MyAppPublisher "DeepDesk Contributors"
#define MyAppExeName "DeepDesk.exe"
#define MyAppUserModelId "com.david.deepdesk"

#ifndef BuildArch
  #define BuildArch "x64"
#endif
#if BuildArch == "x64"
  #define TargetArchitecture "x64os"
#elif BuildArch == "arm64"
  #define TargetArchitecture "arm64"
#else
  #error BuildArch must be x64 or arm64.
#endif

[Setup]
; AppId is deliberately stable: newer installers upgrade the existing per-user install.
AppId={{A34E6F7D-8B1B-4C6F-A4E5-5F4E7B1A9C21}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
VersionInfoVersion={#NumericAppVersion}
VersionInfoProductTextVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/david1025/deepdesk
AppSupportURL=https://github.com/david1025/deepdesk/issues
DefaultDirName={localappdata}\Programs\DeepDesk
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\..\artifacts\installer
OutputBaseFilename=DeepDesk-Setup-{#MyAppVersion}-{#BuildArch}
ArchitecturesInstallIn64BitMode={#TargetArchitecture}
ArchitecturesAllowed={#TargetArchitecture}
#if BuildArch == "arm64"
MinVersion=10.0.22000
#endif
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\src\DeepDesk\Assets\deepdesk-icon.ico
PrivilegesRequired=lowest
Uninstallable=yes
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
; This is a preview build, unsigned until a code-signing certificate is available.

[Files]
; Install the complete published app, including WebView2 runtime loader and UI assets.
; Never place profiles, encryption keys, chats or downloaded files here.
Source: "..\..\..\artifacts\DeepDesk-win-{#BuildArch}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelId}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelId}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: postinstall nowait skipifsilent

; There is deliberately no [UninstallDelete] directive for LocalAppData.
; %LOCALAPPDATA%\DeepDesk\WebView2, credentials, settings and logs survive upgrades
; and uninstallation. Never delete those directories from the installer.
