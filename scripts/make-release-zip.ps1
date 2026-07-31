# ============================================================
# make-release-zip.ps1 —— 创建发布 zip
#
# 解决两个问题：
#   1. tar -a 在 Git Bash (GNU tar) 下会生成 tar 而非 zip
#   2. Compress-Archive 会对已压缩的 node-portable.zip 二次压缩（慢）
#
# 策略：用 .NET ZipArchive，对 .zip 后缀 entry 用 NoCompression（store），
# 其余用 Optimal。node-portable.zip (~90MB) 直接存储秒级完成。
# ============================================================

param(
  [string]$Source = "release\AgentChat",
  [string]$Out    = "release\AgentChat-latest-win-x64.zip"
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path $Out) { Remove-Item $Out -Force }

$base = (Resolve-Path $Source).Path
$fs = [System.IO.File]::Open($Out, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)

$count = 0
Get-ChildItem -Path $base -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/')
  $arcName = "AgentChat/" + ($rel -replace '\\', '/')
  # 已压缩文件用 store，其余 deflate
  $level = if ($_.Extension -eq '.zip') {
    [System.IO.Compression.CompressionLevel]::NoCompression
  } else {
    [System.IO.Compression.CompressionLevel]::Optimal
  }
  $entry = $zip.CreateEntry($arcName, $level)
  $es = $entry.Open()
  try {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $es.Write($bytes, 0, $bytes.Length)
  } finally {
    $es.Dispose()
  }
  $count++
}

$zip.Dispose()
$fs.Dispose()
Write-Host "zip created: $Out ($count files)"
