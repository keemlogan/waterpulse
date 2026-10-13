param(
    [int]$ClickX, [int]$ClickY,                 # screen point inside the guest to click first
    [Parameter(Mandatory)][string[]]$Keys       # SendKeys strings, sent one by one
)
# Types into the VMware guest ONLY while VMware Workstation is the foreground window.
# Aborts before any key if focus is elsewhere (prevents typing into other apps).
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public class GT {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte sc,uint f,UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
}
'@ -ErrorAction SilentlyContinue
$vm = Get-Process vmware -ErrorAction Stop | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
$h = $vm.MainWindowHandle
function Assert-Front { if ([GT]::GetForegroundWindow() -ne $h) { throw "ABORT: VMware is not the foreground window; no keys sent." } }

# ALT tap lets a background process take foreground
[GT]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [GT]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
[GT]::ShowWindow($h,3) | Out-Null; [GT]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 700
Assert-Front
if ($ClickX) { [GT]::SetCursorPos($ClickX,$ClickY) | Out-Null; Start-Sleep -Milliseconds 200; [GT]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [GT]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 600 }
foreach ($k in $Keys) { Assert-Front; [System.Windows.Forms.SendKeys]::SendWait($k); Start-Sleep -Milliseconds 300 }
Assert-Front
[System.Windows.Forms.SendKeys]::SendWait('^%')   # release guest input grab
"sent $($Keys.Count) key groups to VMware guest"
