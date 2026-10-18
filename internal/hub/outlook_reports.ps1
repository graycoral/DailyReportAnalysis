  'reports' {
    $cursors = @{}
    if ($req.cursors) { foreach ($p in $req.cursors.PSObject.Properties) { $cursors[$p.Name] = $p.Value } }
    $found = New-Object System.Collections.ArrayList
    $count = 0; $bytes = 0; $pending = $false; $failed = 0
    foreach ($src in @($req.sources)) {
      if (-not $src.folder_id) { continue }
      if ($count -ge [int]$req.limit) { $pending = $true; break }
      try {
        $store = StoreOf $src
        $folder = $ns.GetFolderFromID($src.folder_id, $store.StoreID)
        $key = [string]$src.folder_id
        $cursor = $cursors[$key]
        $since = if ($cursor.time) { [datetime]::Parse($cursor.time, [Globalization.CultureInfo]::InvariantCulture) } else { [datetime]::MinValue }
        $filter = if ($cursor.time) { "[LastModificationTime] >= '" + $since.ToString('g') + "'" } else { '' }
        $table = $folder.GetTable($filter, 0)
        [void]$table.Columns.Add('ReceivedTime'); [void]$table.Columns.Add('SenderName')
        $table.Sort('LastModificationTime', $false)
        while (-not $table.EndOfTable) {
          if ($count -ge [int]$req.limit -or $bytes -ge 8388608) { $pending = $true; break }
          $row = $table.GetNextRow()
          $modified = [datetime]$row.Item('LastModificationTime')
          $id = [string]$row.Item('EntryID')
          if ($modified -lt $since -or ($modified -eq $since -and @($cursor.ids) -contains $id)) { continue }
          $count++
          if (([string]$row.Item('MessageClass')).StartsWith('IPM.Note')) {
            $item = $ns.GetItemFromID($id, $store.StoreID)
            $body = [string]$item.Body
            if ($body.Length -gt 2097152 -or $body.TrimStart([char]0xFEFF, [char]32, [char]13, [char]10) -notmatch '^---\r?\n') { $body = '' }
            $attachments = New-Object System.Collections.ArrayList
            foreach ($att in $item.Attachments) {
              if ([string]$att.FileName -notmatch '\.md$' -or $att.Size -gt 2097152) { continue }
              if ($attachments.Count -ge 8) { break }
              $data = $att.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37010102')
              try { $text = (New-Object Text.UTF8Encoding($false, $true)).GetString([byte[]]$data) } catch { continue }
              [void]$attachments.Add(@{ name=[string]$att.FileName; body=$text })
            }
            $mail = @{entry_id=$id; store_id=[string]$store.StoreID; path=[string]$src.path; subject=[string]$row.Item('Subject'); sender=[string]$row.Item('SenderName'); received=([datetime]$row.Item('ReceivedTime')).ToString('yyyy-MM-ddTHH:mm:ss'); folder=[string]$folder.Name}
            [void]$found.Add(@{mail=$mail; folder_id=[string]$src.folder_id; body=$body; attachments=$attachments})
            $bytes += [Text.Encoding]::UTF8.GetByteCount($body)
            foreach ($attachment in $attachments) { $bytes += [Text.Encoding]::UTF8.GetByteCount($attachment.body) }
            if ([Runtime.InteropServices.Marshal]::IsComObject($item)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item) }
          }
          $ids = if ($modified -eq $since) { @($cursor.ids) + @($id) } else { @($id) }
          $cursor = @{time=$modified.ToString('yyyy-MM-ddTHH:mm:ss.fffffff', [Globalization.CultureInfo]::InvariantCulture); ids=@($ids)}
          $since = $modified; $cursors[$key] = $cursor
        }
      } catch { $failed++ }
    }
    Send @{items=$found; cursors=$cursors; pending=$pending; failed=$failed; scanned=$count}
  }
