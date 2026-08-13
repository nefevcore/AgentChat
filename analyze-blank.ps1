$files = Get-ChildItem "C:\Users\xiaofeng\Documents\Dev\AgentChat\workspace\default\usage\token_*.jsonl"
$pair = @{}
$byAgent = @{}
foreach ($f in $files) {
  Get-Content $f.FullName | ForEach-Object {
    try {
      $r = $_ | ConvertFrom-Json
      $tk = [double]$r.total_tokens
      $byAgent[$r.agent] = [double]($byAgent[$r.agent] + $tk)
      $cp = $r.counterpart
      if ($cp -and $cp -ne '?') {
        $key = @($r.agent, $cp) | Sort-Object
        $k = "$($key[0])|$($key[1])"
        $pair[$k] = [double]($pair[$k] + $tk)
      }
    } catch {}
  }
}
function IsGroupCp($id) { return $id.StartsWith('group') -or $id.StartsWith('room') }
# 每个 agent 的排除量（user/self/group）与 agent 间 pair 总量
$rows = @()
foreach ($a in $byAgent.GetEnumerator()) {
  $ag = $a.Key
  $raw = [double]$a.Value
  $user = 0.0; $self = 0.0; $grp = 0.0; $agentPair = 0.0
  foreach ($p in $pair.GetEnumerator()) {
    $parts = $p.Key -split '\|'
    $v = [double]$p.Value
    if (-not ($parts -contains $ag)) { continue }
    if ($parts[0] -eq $parts[1]) { $self += $v }
    elseif ($parts[0] -eq 'user' -or $parts[1] -eq 'user') { $user += $v }
    elseif (IsGroupCp $parts[0] -or (IsGroupCp $parts[1])) { $grp += $v }
    else { $agentPair += $v }
  }
  $eff = [math]::Max(0, $raw - $user - $self - $grp)
  $blank = $eff - $agentPair  # effTokens 中无弦的部分
  $rows += [pscustomobject]@{ agent = $ag; rawM = [math]::Round($raw/1e6,1); effM = [math]::Round($eff/1e6,2); pairM = [math]::Round($agentPair/1e6,2); blankM = [math]::Round($blank/1e6,2); userM = [math]::Round($user/1e6,1); selfM = [math]::Round($self/1e6,1); grpM = [math]::Round($grp/1e6,1) }
}
$rows | Where-Object { $_.effM -gt 0 } | Sort-Object effM -Descending | Format-Table -AutoSize | Out-String -Width 200
