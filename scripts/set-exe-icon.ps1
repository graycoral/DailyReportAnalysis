# Build-only resource stamping. Run before embedding the viewer, signing, or hashing.
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-updateresourcew
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [string]$Icon = (Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/av-report-hub.ico'),
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
if (-not ('AVHub.IconResource' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace AVHub {
    public static class IconResource {
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr BeginUpdateResource(string path, bool deleteExisting);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool EndUpdateResource(IntPtr update, bool discard);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern uint SizeofResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll")]
        static extern IntPtr LockResource(IntPtr resource);
        [DllImport("kernel32.dll")]
        static extern bool FreeLibrary(IntPtr module);
        [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr LoadImage(IntPtr module, IntPtr name, uint type, int width, int height, uint flags);
        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr icon);

        static void Check(bool ok, string operation) {
            if (!ok) { int code = Marshal.GetLastWin32Error(); throw new Win32Exception(code, operation + ": " + new Win32Exception(code).Message); }
        }
        static void Match(IntPtr module, int type, int id, byte[] expected) {
            IntPtr resource = FindResource(module, (IntPtr)id, (IntPtr)type);
            Check(resource != IntPtr.Zero, "Find icon resource");
            if (SizeofResource(module, resource) != expected.Length) throw new InvalidDataException("Icon resource size mismatch");
            IntPtr loaded = LoadResource(module, resource);
            Check(loaded != IntPtr.Zero, "Load icon resource");
            IntPtr data = LockResource(loaded);
            Check(data != IntPtr.Zero, "Lock icon resource");
            byte[] actual = new byte[expected.Length];
            Marshal.Copy(data, actual, 0, actual.Length);
            for (int i=0; i<actual.Length; i++)
                if (actual[i] != expected[i]) throw new InvalidDataException("Icon resource content mismatch");
        }

        public static void Apply(string exe, string icon, bool verifyOnly) {
            byte[] ico = File.ReadAllBytes(icon);
            if (ico.Length < 6 || BitConverter.ToUInt16(ico, 0) != 0 || BitConverter.ToUInt16(ico, 2) != 1)
                throw new InvalidDataException("Invalid ICO header");
            int count = BitConverter.ToUInt16(ico, 4);
            if (count == 0 || ico.Length < 6 + 16*count) throw new InvalidDataException("Invalid ICO directory");
            byte[][] images = new byte[count][];
            byte[] group = new byte[6 + 14*count];
            Array.Copy(ico, group, 6);
            for (int i=0; i<count; i++) {
                int entry = 6+16*i;
                uint length = BitConverter.ToUInt32(ico, entry+8), offset = BitConverter.ToUInt32(ico, entry+12);
                if (length == 0 || offset < 6+16*count || (ulong)offset+length > (ulong)ico.Length)
                    throw new InvalidDataException("Invalid ICO image bounds");
                images[i] = new byte[length];
                Array.Copy(ico, (long)offset, images[i], 0, (long)length);
                Array.Copy(ico, entry, group, 6+14*i, 12);
                Array.Copy(BitConverter.GetBytes((ushort)(i+1)), 0, group, 6+14*i+12, 2);
            }
            if (!verifyOnly) {
                IntPtr update = BeginUpdateResource(exe, false);
                Check(update != IntPtr.Zero, "Begin resource update");
                try {
                    for (int i=0; i<count; i++) Check(UpdateResource(update, (IntPtr)3, (IntPtr)(i+1), 0, images[i], (uint)images[i].Length), "Write icon frame");
                    Check(UpdateResource(update, (IntPtr)14, (IntPtr)1, 0, group, (uint)group.Length), "Write icon group");
                    bool saved = EndUpdateResource(update, false);
                    update = IntPtr.Zero;
                    Check(saved, "Commit resource update");
                } finally { if (update != IntPtr.Zero) EndUpdateResource(update, true); }
            }
            // Read as data, without executing the EXE. Verify every frame and Windows decoding.
            IntPtr module = LoadLibraryEx(exe, IntPtr.Zero, 0x22);
            Check(module != IntPtr.Zero, "Open EXE resources for verification");
            try {
                Match(module, 14, 1, group);
                for (int i=0; i<count; i++) {
                    Match(module, 3, i+1, images[i]);
                    int size = ico[6+16*i] == 0 ? 256 : ico[6+16*i];
                    IntPtr decoded = LoadImage(module, (IntPtr)1, 1, size, size, 0);
                    Check(decoded != IntPtr.Zero, "Decode icon at " + size + " px");
                    DestroyIcon(decoded);
                }
            } finally { FreeLibrary(module); }
        }
    }
}
'@
}
$exePath = (Resolve-Path -LiteralPath $Executable).Path
$iconPath = (Resolve-Path -LiteralPath $Icon).Path
for ($attempt=0; ; $attempt++) {
    try {
        [AVHub.IconResource]::Apply($exePath, $iconPath, $VerifyOnly.IsPresent)
        break
    } catch {
        # A newly built EXE can be held briefly by Windows file scanners.
        $cause = $_.Exception.InnerException
        if ($attempt -ge 4 -or $cause -isnot [ComponentModel.Win32Exception] -or $cause.NativeErrorCode -notin @(32,33,110)) { throw }
        Start-Sleep -Milliseconds 500
    }
}
Write-Host "Verified embedded icon: $Executable"
