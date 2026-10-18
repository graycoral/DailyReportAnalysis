  'reports' {
    function ReadEmbeddedReports($storeID, $entryID, $maximum) {
      if (-not $script:embeddedReader) {
        Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('# EMBEDDED_REPORT_SOURCE')))
        $script:embeddedReader = New-Object OutlookEmbeddedReader([string]$ns.CurrentProfileName)
      }
      return $script:embeddedReader.Read($storeID, $entryID, $maximum)
    }
    $script:embeddedReader = $null
    try {
    $cursors = @{}
    if ($req.cursors) { foreach ($p in $req.cursors.PSObject.Properties) { $cursors[$p.Name] = $p.Value } }
    $found = New-Object System.Collections.ArrayList
    $count = 0; $bytes = 0; $pending = $false; $failed = 0; $limited = 0
    foreach ($src in @($req.sources)) {
      if (-not $src.folder_id) { continue }
      if ($count -ge [int]$req.limit) { $pending = $true; break }
      try {
        $store = StoreOf $src
        $folder = $ns.GetFolderFromID($src.folder_id, $store.StoreID)
        $key = [string]$src.folder_id
        $cursor = $cursors[$key]
        if (-not $cursor) { $cursor = @{time=''; ids=@()} }
        $since = if ($cursor.time) { [datetime]::Parse($cursor.time, [Globalization.CultureInfo]::InvariantCulture) } else { [datetime]::MinValue }
        $filter = if ($cursor.time) { "[LastModificationTime] >= '" + $since.ToString('g') + "'" } else { '' }
        $table = $folder.GetTable($filter, 0)
        [void]$table.Columns.Add('ReceivedTime'); [void]$table.Columns.Add('SenderName')
        $table.Sort('LastModificationTime', $false)
        $cursors[$key] = $cursor
        while (-not $table.EndOfTable) {
          if ($count -ge [int]$req.limit -or $bytes -ge 8388608) { $pending = $true; break }
          $row = $table.GetNextRow()
          $modified = [datetime]$row.Item('LastModificationTime')
          $id = [string]$row.Item('EntryID')
          if ($modified -lt $since -or ($modified -eq $since -and @($cursor.ids) -contains $id)) { continue }
          $count++
          $retry = $false
          if (([string]$row.Item('MessageClass')).StartsWith('IPM.Note')) {
            $item = $ns.GetItemFromID($id, $store.StoreID)
            try {
            $body = [string]$item.Body
            if ($body.Length -gt 2097152 -or $body.TrimStart([char]0xFEFF, [char]32, [char]13, [char]10) -notmatch '^---\r?\n') { $body = '' }
            $attachments = New-Object System.Collections.ArrayList
            $fingerprints = New-Object System.Collections.ArrayList
            $hashedBytes = 0; $embedded = $false
            foreach ($att in $item.Attachments) {
              if ([int]$att.Type -eq 5) {
                if ($att.Size -le 52428800) { $embedded = $true } else { $limited++ }
                continue
              }
              # Only document attachments: embedded signature images are not evidence.
              # Read bytes in memory, retain a hash only; never create temporary copies.
              if ([string]$att.FileName -notmatch '\.(md|pdf|docx?|pptx?|xlsx?|txt|csv)$' -or $att.Size -gt 52428800) { continue }
              # Report extraction has its own 2MB / 8-file budget. Exhausting
              # optional fingerprint work must never drop a report or advance
              # its cursor past a failed read.
              $readReport = [string]$att.FileName -match '\.md$' -and $att.Size -le 2097152 -and $attachments.Count -lt 8
              $hashAttachment = $fingerprints.Count -lt 32 -and $hashedBytes + $att.Size -le 52428800
              if (-not $readReport -and -not $hashAttachment) { continue }
              try { $data = [byte[]]$att.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37010102') } catch {
                if ($readReport) { $failed++; $retry = $true }
                continue
              }
              if ($hashAttachment -and $data.Length -gt 0 -and $hashedBytes + $data.Length -le 52428800) {
                $hashedBytes += $data.Length
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $hash = ([BitConverter]::ToString($sha.ComputeHash($data))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
                [void]$fingerprints.Add(@{name=[string]$att.FileName; sha256=$hash})
              }
              if ($readReport -and $data.Length -le 2097152) {
                try { $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($data) } catch { continue }
                [void]$attachments.Add(@{ name=[string]$att.FileName; body=$text })
              }
            }
            if ($embedded) {
              try {
                $inner = ReadEmbeddedReports ([string]$store.StoreID) $id (8 - $attachments.Count)
                foreach ($file in $inner.Files) {
                  [void]$attachments.Add(@{name=$file.Name; body=$file.Body})
                  $sha = [Security.Cryptography.SHA256]::Create()
                  try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($file.Body)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
                  [void]$fingerprints.Add(@{name=$file.Name; sha256=$hash})
                }
                $limited += $inner.Limited
                $failed += $inner.Failed
                if ($inner.Failed -gt 0) { $retry = $true }
              } catch { $failed++; $retry = $true }
            }
            $conversation = ''; try { $conversation = [string]$item.ConversationID } catch {}
            $mail = @{entry_id=$id; store_id=[string]$store.StoreID; path=[string]$src.path; subject=[string]$row.Item('Subject'); sender=[string]$row.Item('SenderName'); received=([datetime]$row.Item('ReceivedTime')).ToString('yyyy-MM-ddTHH:mm:ss'); folder=[string]$folder.Name}
            [void]$found.Add(@{mail=$mail; folder_id=[string]$src.folder_id; body=$body; attachments=$attachments; conversation=$conversation; fingerprints=$fingerprints})
            $bytes += [Text.Encoding]::UTF8.GetByteCount($body)
            foreach ($attachment in $attachments) { $bytes += [Text.Encoding]::UTF8.GetByteCount($attachment.body) }
            } finally { if ([Runtime.InteropServices.Marshal]::IsComObject($item)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item) } }
          }
          # Save any successful candidates, but leave unread mail before the
          # cursor so a transient embedded-message failure is retried next time.
          if ($retry) { break }
          $ids = if ($modified -eq $since) { @($cursor.ids) + @($id) } else { @($id) }
          $cursor = @{time=$modified.ToString('yyyy-MM-ddTHH:mm:ss.fffffff', [Globalization.CultureInfo]::InvariantCulture); ids=@($ids)}
          $since = $modified; $cursors[$key] = $cursor
        }
      } catch { $failed++ }
    }
    Send @{items=$found; cursors=$cursors; pending=$pending; failed=$failed; limited=$limited; scanned=$count}
    } finally { if ($script:embeddedReader) { $script:embeddedReader.Dispose() } }
  }
