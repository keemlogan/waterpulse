param(
    [Parameter(Mandatory)][string]$Name,       
    [string]$WindowMatch = ''                  # process name or window title regex to bring to front
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinFront2 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
}
'@ -ErrorAction SilentlyContinue

if ($WindowMatch) {
    $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -match $WindowMatch -or $_.MainWindowTitle -match $WindowMatch) } | Select-Object -First 1
    if (-not $p) { throw "window not found: $WindowMatch (nothing saved)" }
    $h = $p.MainWindowHandle
    # A background process may not take the foreground; an ALT tap lifts the foreground lock.
    # If the window still is not in front, fail instead of saving a screenshot of the wrong window.
    for ($i = 0; $i -lt 3 -and [WinFront2]::GetForegroundWindow() -ne $h; $i++) {
        [WinFront2]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [WinFront2]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [WinFront2]::ShowWindow($h, 3) | Out-Null   # maximize
        [WinFront2]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 600
    }
    if ([WinFront2]::GetForegroundWindow() -ne $h) { throw "could not bring '$WindowMatch' to front (nothing saved)" }
    Start-Sleep -Milliseconds 400
}

$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$out = Join-Path 'E:\WaterPulse\captures' ($Name + '.png')
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved $out"
