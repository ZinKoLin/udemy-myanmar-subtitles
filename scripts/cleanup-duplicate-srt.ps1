[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Directory = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'),
    [ValidateRange(1, 1440)][int]$MinimumAgeMinutes = 5
)

$ErrorActionPreference = 'Stop'
$root = Get-Item -LiteralPath $Directory
if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The cleanup directory must be a real folder, not a link.'
}
$cutoff = [DateTime]::UtcNow.AddMinutes(-$MinimumAgeMinutes)
$files = @(Get-ChildItem -LiteralPath $root.FullName -File | Where-Object {
    $_.Extension -ieq '.srt' -and
    -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
    $_.LastWriteTimeUtc -lt $cutoff
})
$recycled = [Collections.Generic.List[string]]::new()
$failures = [Collections.Generic.List[string]]::new()
$planned = 0
Add-Type -AssemblyName Microsoft.VisualBasic

# Only equal-length candidates need hashing. Subfolders and other file types stay untouched.
foreach ($sizeGroup in ($files | Group-Object Length | Where-Object Count -gt 1)) {
    $hashed = foreach ($file in $sizeGroup.Group) {
        try {
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            $current = Get-Item -LiteralPath $file.FullName
            if ($current.Length -ne $file.Length -or $current.LastWriteTimeUtc -ne $file.LastWriteTimeUtc) {
                throw 'File changed while being checked.'
            }
            [pscustomobject]@{ File = $file; Hash = $hash }
        } catch { $failures.Add($file.Name) }
    }
    foreach ($hashGroup in ($hashed | Group-Object Hash | Where-Object Count -gt 1)) {
        # Retain the oldest copy, with a stable filename tie-breaker.
        $copies = @($hashGroup.Group | Sort-Object @{Expression={$_.File.LastWriteTimeUtc}}, @{Expression={$_.File.FullName}})
        $keep = $copies[0].File
        foreach ($copy in $copies | Select-Object -Skip 1) {
            $extra = $copy.File
            try {
                foreach ($path in @($keep.FullName, $extra.FullName)) {
                    $item = Get-Item -LiteralPath $path
                    if ($item.PSIsContainer -or $item.Extension -ine '.srt' -or
                        $item.DirectoryName -ine $root.FullName -or
                        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                        $item.LastWriteTimeUtc -ge $cutoff -or
                        $item.Length -ne $keep.Length -or
                        (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $copy.Hash) {
                        throw 'Duplicate or retained copy changed; keeping both.'
                    }
                }
                $planned++
                if ($PSCmdlet.ShouldProcess($extra.FullName, 'Move duplicate SRT to Recycle Bin; retain ' + $keep.Name)) {
                    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
                        $extra.FullName,
                        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
                    )
                    if (Test-Path -LiteralPath $extra.FullName) { throw 'The duplicate could not be recycled.' }
                    $recycled.Add($extra.Name)
                }
            } catch { $failures.Add($extra.Name) }
        }
    }
}
[pscustomobject]@{
    Directory = $root.FullName
    EligibleSrtFiles = $files.Count
    DuplicateCopies = $planned
    RecycledCopies = $recycled.Count
    RecycledNames = @($recycled.ToArray())
    FailedNames = @($failures.ToArray())
} | ConvertTo-Json -Depth 3
if ($failures.Count) { throw 'Some files could not be safely checked or recycled; they were preserved where possible.' }
