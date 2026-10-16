# AV Report Hub - classic Outlook bridge. Script and base64 JSON arrive through stdin.
# Matching reports from explicitly selected folders may be returned to encrypted local storage.
# Output: base64 UTF-8 JSON on stdout, either the result or {error, code}.
$ErrorActionPreference = 'Stop'
function Send($o) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $o -Depth 5 -Compress)))) }
function Fail($code, $msg) { Send @{ error = [string]$msg; code = $code }; exit 0 }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Fail 'clm' 'PowerShell language mode' }
$req = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))
try { $ol = New-Object -ComObject Outlook.Application; $ns = $ol.GetNamespace('MAPI') } catch { Fail 'com' $_.Exception.Message }

function FilePathOf($s) { try { return [string]$s.FilePath } catch { return '' } }
# A configured source is a profile mailbox (StoreID) or a PST/OST path; a PST that is not open yet is added to the profile.
function StoreOf($src) {
  foreach ($s in $ns.Stores) {
    if ($src.store_id -and $s.StoreID -eq $src.store_id) { return $s }
    $p = FilePathOf $s
    if ($src.path -and $p -and $p -ieq $src.path) { return $s }
  }
  if ($src.path -and $src.path -match '\.pst$') {
    if (-not (Test-Path -LiteralPath $src.path)) { Fail 'source' ('PST 파일을 찾을 수 없습니다: ' + $src.path) }
    $ns.AddStoreEx($src.path, 1)
    foreach ($s in $ns.Stores) { $p = FilePathOf $s; if ($p -and $p -ieq $src.path) { return $s } }
  }
  Fail 'source' ('Outlook에서 열 수 없는 자료입니다: ' + $src.name + ' (OST는 현재 Outlook 프로필의 메일함만 사용할 수 있습니다)')
}
function Skip($store) {
  $ids = @{}
  # Deleted Items, Outbox, Junk E-mail are not searched.
  foreach ($n in 3, 4, 23) { try { $ids[$store.GetDefaultFolder($n).EntryID] = 1 } catch {} }
  return $ids
}

switch ($req.op) {
  # REPORT_IMPORT_CASE
  'folders' {
    $list = New-Object System.Collections.ArrayList
    $store = StoreOf $req.sources[0]
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($store.GetRootFolder(), [string]$store.DisplayName))
    $skip = Skip $store
    while ($queue.Count -gt 0) {
      $folder, $path = $queue.Dequeue()
      if ($skip.ContainsKey($folder.EntryID)) { continue }
      foreach ($f in $folder.Folders) { $queue.Enqueue(@($f, ($path + '/' + $f.Name))) }
      if ($folder.DefaultItemType -eq 0) { [void]$list.Add(@{name=$path; folder_name=[string]$folder.Name; folder_id=[string]$folder.EntryID; store_id=[string]$store.StoreID; path=(FilePathOf $store)}) }
    }
    Send @{folders=$list}
  }
  'stores' {
    $list = New-Object System.Collections.ArrayList
    foreach ($s in $ns.Stores) { try { [void]$list.Add(@{ name = [string]$s.DisplayName; path = (FilePathOf $s); store_id = [string]$s.StoreID }) } catch {} }
    Send @{ stores = $list }
  }
  'search' {
    $parts = foreach ($t in @($req.terms)) {
      $q = ([string]$t) -replace "'", "''"
      '("urn:schemas:httpmail:subject" LIKE ''%' + $q + '%'' OR "urn:schemas:httpmail:textdescription" LIKE ''%' + $q + '%'')'
    }
    $filter = '@SQL=' + ($parts -join $(if ($req.all) { ' AND ' } else { ' OR ' }))
    $from = if ($req.from) { [datetime]::ParseExact($req.from, 'yyyy-MM-dd', $null) } else { [datetime]::MinValue }
    $to = if ($req.to) { [datetime]::ParseExact($req.to, 'yyyy-MM-dd', $null).AddDays(1) } else { [datetime]::MaxValue }
    $limit = [int]$req.limit
    $found = New-Object System.Collections.ArrayList
    foreach ($src in @($req.sources)) {
      $store = StoreOf $src
      $skip = Skip $store
      $queue = New-Object System.Collections.Queue
      $root = $store.GetRootFolder()
      if ($src.folder_id) { $root = $ns.GetFolderFromID($src.folder_id, $store.StoreID) }
      $queue.Enqueue(@($root, [string]$store.DisplayName))
      while ($queue.Count -gt 0) {
        $folder, $path = $queue.Dequeue()
        if ($skip.ContainsKey($folder.EntryID)) { continue }
        if (-not $src.folder_id) { foreach ($f in $folder.Folders) { $queue.Enqueue(@($f, ($path + '/' + $f.Name))) } }
        if ($folder.DefaultItemType -ne 0) { continue }
        try {
          $t = $folder.GetTable($filter, 0)
          [void]$t.Columns.Add('ReceivedTime'); [void]$t.Columns.Add('SenderName')
          $t.Sort('[ReceivedTime]', $true)
          $n = 0
          while (-not $t.EndOfTable -and $n -lt $limit) {
            $r = $t.GetNextRow()
            if (-not ([string]$r.Item('MessageClass')).StartsWith('IPM.Note')) { continue }
            $rt = [datetime]$r.Item('ReceivedTime')
            if ($rt -ge $to) { continue }
            if ($rt -lt $from) { break }
            $n++
            [void]$found.Add(@{ entry_id = [string]$r.Item('EntryID'); store_id = [string]$store.StoreID; path = [string]$src.path; subject = [string]$r.Item('Subject'); sender = [string]$r.Item('SenderName'); received = $rt.ToString('yyyy-MM-ddTHH:mm:ss'); folder = $path })
          }
        } catch {}
      }
    }
    $out = New-Object System.Collections.ArrayList
    foreach ($m in @($found | Sort-Object { $_.received } -Descending | Select-Object -First $limit)) { [void]$out.Add($m) }
    Send @{ mails = $out }
  }
  'open' {
    $m = $req.mail
    if ($m.path) { [void](StoreOf @{ path = $m.path; name = $m.path }) }
    try { $item = $ns.GetItemFromID($m.entry_id, $m.store_id) } catch { Fail 'item' $_.Exception.Message }
    $item.Display()
    Send @{ ok = $true }
  }
  default { Fail 'op' 'unknown operation' }
}
