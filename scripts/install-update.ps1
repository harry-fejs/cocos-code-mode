param(
    [Parameter(Mandatory = $true)][int] $CreatorPid,
    [Parameter(Mandatory = $true)][string] $CreatorExecutablePath,
    [string] $StagedDirectory,
    [Parameter(Mandatory = $true)][string] $LiveDirectory,
    [string] $DescriptorSha256,
    [switch] $RollbackPendingHealth
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-FullPath([string] $Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Get-Sha256([string] $Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-Contained([string] $Root, [string] $Candidate) {
    $prefix = $Root + [IO.Path]::DirectorySeparatorChar
    if (-not $Candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "manifest path escapes staged root"
    }
}

function Assert-StagedDirectory([string] $Root, [string] $ReleaseRoot, [string] $ExpectedDescriptorSha256) {
    $descriptorPath = Join-Path $Root ".ccp-staged.json"
    $manifestPath = Join-Path $Root ".ccp-package-manifest.json"
    if (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { throw "activation descriptor missing" }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "package manifest missing" }
    if ((Get-Sha256 $descriptorPath) -ne $ExpectedDescriptorSha256) { throw "activation descriptor digest mismatch" }
    $descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
    if ($descriptor.schemaVersion -ne 1 -or $descriptor.packageSha256 -notmatch '^[a-f0-9]{64}$' -or
        $descriptor.packageBytes -le 0 -or $descriptor.packageManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
        $descriptor.sbomSha256 -notmatch '^[a-f0-9]{64}$' -or $descriptor.provenanceSha256 -notmatch '^[a-f0-9]{64}$' -or
        $descriptor.targetPayloadSha256 -notmatch '^[a-f0-9]{64}$' -or $descriptor.policyPayloadSha256 -notmatch '^[a-f0-9]{64}$' -or
        $descriptor.rootMetadataSha256 -notmatch '^[a-f0-9]{64}$' -or
        $descriptor.targetMetadataSha256 -notmatch '^[a-f0-9]{64}$' -or
        $descriptor.policyMetadataSha256 -notmatch '^[a-f0-9]{64}$') {
        throw "activation descriptor invalid"
    }
    $releaseArtifacts = @(
        @{ Name = "release.zip"; Hash = $descriptor.packageSha256; Bytes = [long]$descriptor.packageBytes },
        @{ Name = "package-manifest.json"; Hash = $descriptor.packageManifestSha256; Bytes = 0 },
        @{ Name = "sbom.cdx.json"; Hash = $descriptor.sbomSha256; Bytes = 0 },
        @{ Name = "provenance.intoto.json"; Hash = $descriptor.provenanceSha256; Bytes = 0 },
        @{ Name = "root.signed.json"; Hash = $descriptor.rootMetadataSha256; Bytes = 0 },
        @{ Name = "target.signed.json"; Hash = $descriptor.targetMetadataSha256; Bytes = 0 },
        @{ Name = "policy.signed.json"; Hash = $descriptor.policyMetadataSha256; Bytes = 0 }
    )
    foreach ($artifact in $releaseArtifacts) {
        $artifactPath = Join-Path $ReleaseRoot $artifact.Name
        if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf) -or (Get-Sha256 $artifactPath) -ne $artifact.Hash) {
            throw "immutable release-set digest mismatch"
        }
        if ($artifact.Bytes -gt 0 -and (Get-Item -LiteralPath $artifactPath).Length -ne $artifact.Bytes) {
            throw "immutable release ZIP size mismatch"
        }
    }
    if ((Get-Sha256 $manifestPath) -ne $descriptor.packageManifestSha256) { throw "package manifest digest mismatch" }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.package -ne "ccp3x" -or $manifest.version -ne $descriptor.version) {
        throw "package manifest identity mismatch"
    }
    $declared = @{}
    foreach ($entry in $manifest.files) {
        if ($entry.path -notmatch '^ccp3x/.+' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw "package manifest entry invalid"
        }
        $relativePath = $entry.path.Substring("ccp3x/".Length)
        $relativeKey = $relativePath.ToLowerInvariant()
        if ($declared.ContainsKey($relativeKey)) { throw "package manifest entry duplicated" }
        $full = Get-FullPath (Join-Path $Root ($relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)))
        Assert-Contained $Root $full
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "declared package file missing" }
        $file = Get-Item -LiteralPath $full -Force
        if ($file.LinkType) { throw "package links are not accepted" }
        if ($file.Length -ne [long]$entry.size -or (Get-Sha256 $full) -ne $entry.sha256) { throw "package file digest mismatch" }
        $declared[$relativeKey] = $true
    }
    $actual = @(Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Where-Object {
        $_.Name -ne ".ccp-staged.json" -and $_.Name -ne ".ccp-package-manifest.json"
    })
    if ($actual.Count -ne $declared.Count) { throw "staged file set differs from manifest" }
    foreach ($file in $actual) {
        $relative = $file.FullName.Substring($Root.Length + 1).Replace([IO.Path]::DirectorySeparatorChar, '/').ToLowerInvariant()
        if (-not $declared.ContainsKey($relative)) { throw "undeclared staged file" }
    }
    return $descriptor
}

if ($CreatorPid -le 0) { throw "CreatorPid must be a positive PID" }
$live = Get-FullPath $LiveDirectory
$creatorExecutable = Get-FullPath $CreatorExecutablePath
if (-not (Test-Path -LiteralPath $live -PathType Container)) { throw "live directory missing" }
$process = Get-Process -Id $CreatorPid -ErrorAction Stop
if ((Get-FullPath $process.Path) -ne $creatorExecutable) { throw "PID does not identify the expected Creator executable" }
if ($RollbackPendingHealth) {
    $backup = $live + ".prev"
    $failed = $live + ".failed"
    if (-not (Test-Path -LiteralPath $backup -PathType Container)) { throw "pending-health backup missing" }
    if (Test-Path -LiteralPath $failed) { throw "failed-update quarantine already exists" }
    Write-Output ("state=wait-rollback pid={0}" -f $CreatorPid)
    Wait-Process -Id $CreatorPid -ErrorAction Stop
    Rename-Item -LiteralPath $live -NewName (Split-Path -Leaf $failed)
    try {
        Rename-Item -LiteralPath $backup -NewName (Split-Path -Leaf $live)
        Remove-Item -LiteralPath $failed -Recurse -Force
    } catch {
        if (-not (Test-Path -LiteralPath $live) -and (Test-Path -LiteralPath $failed)) {
            Rename-Item -LiteralPath $failed -NewName (Split-Path -Leaf $live)
        }
        throw
    }
    Write-Output "state=rolled-back"
    exit 0
}
if (-not $StagedDirectory -or $DescriptorSha256 -notmatch '^[a-f0-9]{64}$') { throw "staged directory and descriptor hash are required" }
$staged = Get-FullPath $StagedDirectory
$releaseRoot = Get-FullPath (Split-Path -Parent (Split-Path -Parent $staged))
if (-not (Test-Path -LiteralPath $staged -PathType Container)) { throw "staged directory missing" }
$descriptor = Assert-StagedDirectory $staged $releaseRoot $DescriptorSha256

Write-Output ("state=wait pid={0} target={1}" -f $CreatorPid, $descriptor.targetPayloadSha256)
Wait-Process -Id $CreatorPid -ErrorAction Stop

$liveParent = Split-Path -Parent $live
$liveName = Split-Path -Leaf $live
$candidate = Join-Path $liveParent ($liveName + ".next-" + $descriptor.targetPayloadSha256.Substring(0, 12))
$backup = Join-Path $liveParent ($liveName + ".prev")
if (Test-Path -LiteralPath $candidate) { throw "candidate directory already exists" }
if (Test-Path -LiteralPath $backup) { throw "backup directory already exists; health disposition required" }
New-Item -ItemType Directory -Path $candidate | Out-Null
try {
    Get-ChildItem -LiteralPath $staged -Force | Copy-Item -Destination $candidate -Recurse -Force
    Assert-StagedDirectory $candidate $releaseRoot $DescriptorSha256 | Out-Null
    Rename-Item -LiteralPath $live -NewName (Split-Path -Leaf $backup)
    try {
        Rename-Item -LiteralPath $candidate -NewName $liveName
    } catch {
        Rename-Item -LiteralPath $backup -NewName $liveName
        throw
    }
} catch {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Recurse -Force }
    throw
}
Write-Output ("state=pending-health version={0} target={1}" -f $descriptor.version, $descriptor.targetPayloadSha256)
