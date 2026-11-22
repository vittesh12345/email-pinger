# Reads the Outlook desktop app that is already signed in on this Windows PC, through Outlook's
# COM automation. No app registration, no IT approval, nothing leaves the computer: it uses the
# mailbox the user is already logged into. Read-only — it never changes, moves or sends anything.
#
# Emits one JSON object on stdout: { ok: true, ... } on success, { ok: false, error } on failure.
[CmdletBinding()]
param(
  [string]$Since = "",
  [string]$From = "",
  [string]$To = "",
  [ValidateSet("messages", "events", "test")]
  [string]$What = "messages",
  [int]$Max = 400
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Emit($obj) { [Console]::Out.Write(($obj | ConvertTo-Json -Depth 6 -Compress)) }
function Fail($msg) { Emit @{ ok = $false; error = [string]$msg }; exit 0 }

function To-Iso($dt) {
  if ($null -eq $dt) { return $null }
  try { return ([datetime]$dt).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") } catch { return $null }
}

# Best effort SMTP address for an AddressEntry (Exchange senders come back as an X.500 DN otherwise).
function Get-Smtp($entry) {
  if ($null -eq $entry) { return "" }
  try {
    if ($entry.Type -eq "EX" -or $entry.AddressEntryUserType -eq 0 -or $entry.AddressEntryUserType -eq 10) {
      $u = $entry.GetExchangeUser()
      if ($u -and $u.PrimarySmtpAddress) { return [string]$u.PrimarySmtpAddress }
    }
  } catch {}
  try { if ($entry.Address) { return [string]$entry.Address } } catch {}
  return ""
}

try {
  $outlook = New-Object -ComObject Outlook.Application
  $ns = $outlook.GetNamespace("MAPI")
} catch {
  Fail "Outlook could not be opened. Make sure the Outlook desktop app is installed and set up on this computer."
}

try { $me = $ns.CurrentUser.AddressEntry; $myEmail = Get-Smtp $me; $myName = [string]$ns.CurrentUser.Name } catch { $myEmail = ""; $myName = "" }

if ($What -eq "test") { Emit @{ ok = $true; email = $myEmail; name = $myName }; exit 0 }

if ($What -eq "events") {
  $events = @()
  try {
    $cal = $ns.GetDefaultFolder(9)  # olFolderCalendar
    $items = $cal.Items
    $items.IncludeRecurrences = $true
    $items.Sort("[Start]")
    $f = ([datetime]$From).ToString("MM/dd/yyyy HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
    $t = ([datetime]$To).ToString("MM/dd/yyyy HH:mm", [System.Globalization.CultureInfo]::InvariantCulture)
    $items = $items.Restrict("[Start] >= '$f' AND [Start] <= '$t'")
    $count = 0
    foreach ($appt in $items) {
      if ($count -ge 500) { break }
      try {
        $att = @()
        foreach ($r in $appt.Recipients) { $att += @{ name = [string]$r.Name; email = (Get-Smtp $r.AddressEntry) } }
        $body = ""
        try { $body = [string]$appt.Body; if ($body.Length -gt 2000) { $body = $body.Substring(0, 2000) } } catch {}
        $events += @{
          providerId = ([string]$appt.EntryID) + "|" + (To-Iso $appt.Start)
          title      = [string]$appt.Subject
          startAt    = (To-Iso $appt.Start)
          endAt      = (To-Iso $appt.End)
          attendees  = $att
          location   = [string]$appt.Location
          bodyForLink = $body
          isAllDay   = [bool]$appt.AllDayEvent
          isCancelled = ($appt.MeetingStatus -eq 5 -or $appt.MeetingStatus -eq 7)
          declined   = ($appt.ResponseStatus -eq 4)
        }
        $count++
      } catch {}
    }
  } catch {}
  Emit @{ ok = $true; events = @($events) }
  exit 0
}

# What = messages: the Inbox and Sent Items, newest first, back to $Since.
try { $sinceUtc = if ($Since) { ([datetime]$Since).ToUniversalTime() } else { (Get-Date).AddDays(-14).ToUniversalTime() } } catch { $sinceUtc = (Get-Date).AddDays(-14).ToUniversalTime() }

$messages = @()
$complete = $true

function Read-Folder($folderId, $hint, $dateProp) {
  $folder = $ns.GetDefaultFolder($folderId)
  $items = $folder.Items
  try { $items.Sort("[$dateProp]", $true) } catch {}
  $taken = 0
  foreach ($item in $items) {
    try {
      if ($item.Class -ne 43) { continue }  # olMail only
      $when = if ($hint -eq "sent") { $item.SentOn } else { $item.ReceivedTime }
      $whenUtc = ([datetime]$when).ToUniversalTime()
      if ($whenUtc -lt $sinceUtc) { break }
      if ($taken -ge $script:Max) { $script:complete = $false; break }

      $to = @(); $cc = @()
      foreach ($r in $item.Recipients) {
        $entry = @{ name = [string]$r.Name; email = (Get-Smtp $r.AddressEntry) }
        if ($r.Type -eq 2) { $cc += $entry } else { $to += $entry }
      }
      $fromEmail = ""
      try { if ($item.SenderEmailType -eq "EX") { $ex = $item.Sender.GetExchangeUser(); if ($ex) { $fromEmail = [string]$ex.PrimarySmtpAddress } } } catch {}
      if (-not $fromEmail) { try { $fromEmail = [string]$item.SenderEmailAddress } catch {} }
      $body = ""
      try { $body = [string]$item.Body; if ($body.Length -gt 12000) { $body = $body.Substring(0, 12000) } } catch {}
      $conv = ""; try { $conv = [string]$item.ConversationID } catch {}
      $mid = ""; try { $mid = [string]$item.PropertyAccessor.GetProperty("http://schemas.microsoft.com/mapi/proptag/0x1035001F") } catch {}

      $script:messages += @{
        providerId      = [string]$item.EntryID
        threadKey       = $(if ($conv) { "c:$conv" } else { $null })
        messageIdHeader = $mid
        from            = @{ name = [string]$item.SenderName; email = $fromEmail }
        to              = $to
        cc              = $cc
        subject         = [string]$item.Subject
        body            = $body
        sentAt          = (To-Iso $when)
        isRead          = (-not [bool]$item.UnRead)
        importance      = $(if ($item.Importance -eq 2) { "high" } else { "normal" })
        folderHint      = $hint
        isMeetingMessage = ([string]$item.MessageClass -like "IPM.Schedule*")
      }
      $taken++
    } catch {}
  }
}

try {
  Read-Folder 6 "inbox" "ReceivedTime"   # olFolderInbox
  Read-Folder 5 "sent" "SentOn"          # olFolderSentMail
} catch {
  $msg = $_.Exception.Message
  if ($msg -match "denied|0x80070005|E_ACCESSDENIED") {
    Fail "Outlook refused access. If Outlook showed a security prompt, choose Allow. If it did not, your organization may block other programs from reading Outlook."
  }
  Fail "Outlook could not be read: $msg"
}

Emit @{ ok = $true; complete = $complete; messages = @($messages); account = @{ name = $myName; email = $myEmail } }
