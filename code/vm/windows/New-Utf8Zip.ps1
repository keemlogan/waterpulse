param([Parameter(Mandatory)][string]$Src, [Parameter(Mandatory)][string]$Zip)
# Zip a folder with UTF-8 entry names and '/' separators (macOS/Linux friendly).
# PS 5.1 Compress-Archive uses CP949 names; ZipFile.CreateFromDirectory uses '\' separators.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$Src = (Resolve-Path $Src).Path.TrimEnd('\')
Remove-Item $Zip -ErrorAction SilentlyContinue
$fs = [IO.File]::Open($Zip, 'Create')
$za = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
Get-ChildItem $Src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($Src.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $_.FullName, $rel, 'Optimal') | Out-Null
}
$za.Dispose(); $fs.Dispose()
"zipped $Src -> $Zip"