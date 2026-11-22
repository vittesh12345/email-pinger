# Pinger

Pinger runs on your computer, reads your mailbox and your meeting transcripts, and pings you about what still needs a follow-up.

- **Emails that need your reply** — sorted by priority, with how long each has been waiting.
- **People who haven't answered you** — a nudge reminder after a number of days you choose.
- **Email overviews** — a summary sent as many times a day as you set, at the times you pick.
- **Meeting pop-up** — when a calendar meeting starts, Pinger asks whether to take notes and record a transcript.
- **Meeting memory** — paste or upload a transcript (Teams, Zoom, Meet) or record live; Pinger keeps it, lists what you promised and what you are owed, and reminds you when those are due. You can search or ask questions across past meetings.
- **Mini window** — a small panel that stays on top of Outlook (or any mail app) so you can use both at once.

Everything is stored on your own computer. Mail is only ever read; Pinger cannot send, delete or change anything.

## Start

1. Install [Node.js](https://nodejs.org) 22.13 or newer.
2. Start Pinger:
   - **Mac:** double-click `start.command`
   - **Windows:** double-click `start.bat`
   - **Linux:** run `./start.sh`
3. Pinger opens at <http://localhost:4317> and walks you through setup.

Leave the terminal window open; Pinger keeps checking mail and sending pings while it runs.

To look around before connecting anything, choose **Sample data** in setup. It adds a made-up mailbox and calendar, including a meeting that "starts" two minutes later so you can see the pop-up.

## Connect your email

### Outlook app on a Windows PC (no setup)

If the classic Outlook desktop app is installed and signed in on your Windows PC, choose **Outlook app on this PC**. Pinger reads your mailbox and calendar through that app, on your computer: no Microsoft registration and no approval request. It only reads; it never changes, moves or sends anything.

- Outlook may show a security prompt saying a program is trying to access it. Choose **Allow**.
- On some work PCs, IT settings stop other programs from reading Outlook or stop scripts from running. Pinger then says so, and this option won't work without IT.
- Not available on Mac: the new Outlook for Mac does not let other programs read mail. On a Mac, use Outlook in the browser with the side panel, or the sign-in option below.

### Outlook, Hotmail, Microsoft 365 (sign in)

Microsoft requires every program that reads Outlook mail to be registered. It is free and you do it once:

1. Open [Microsoft Entra → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and choose **New registration**.
2. Name: `Pinger`. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost:4317/auth/microsoft/callback`.
4. Choose **Register**, copy the **Application (client) ID**, and paste it into Pinger (Settings → Email accounts → Outlook).

Then choose **Outlook** again and sign in. Pinger asks for permission to read mail and read the calendar, nothing else. Work accounts may need an IT admin to approve the app.

The ID is saved in `pinger.config.json` inside the app folder. It is not a secret, and it means anyone you share the folder with can sign in to their own Outlook without repeating these steps.

### Gmail, iCloud, Yahoo, Fastmail, other IMAP mailboxes

Choose **Gmail and others** and enter the address and an **app password** (not your normal password). For Gmail: turn on 2-Step Verification, then create one at <https://myaccount.google.com/apppasswords>.

For the meeting pop-up with a non-Outlook calendar, add its private `.ics` link under Settings → Calendar (Google Calendar: Settings → your calendar → "Secret address in iCal format").

## Use it alongside your mail

- **Mini window** (button in the sidebar, or Settings → Use alongside your mail): a compact panel with what needs a reply, nudges, due follow-ups and the meeting-start prompt. In Chrome and Edge it floats on top of every other window, so it stays visible over Outlook. In other browsers it opens as an ordinary small window.
- **Browser side panel:** docks Pinger beside the page you are on, such as Outlook on the web. In Chrome or Edge open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, choose **Load unpacked**, and select the `extension` folder inside this folder. Then click the Pinger icon in the toolbar. The panel shows the same compact view as the mini window, and says so if Pinger is not running.
- **Install as an app:** in Chrome or Edge use the install icon in the address bar. Pinger then has its own window and taskbar icon.
- Keys `1`–`5` switch between Overview, Emails, Follow-ups, Meetings and Settings.

## AI (optional)

Without a key, Pinger sorts mail with built-in rules (who wrote last, questions, requests, deadlines, automated senders).

With a [Claude API key](https://platform.claude.com) (Settings → AI), Pinger also:

- judges what really needs a reply and writes a one-line summary of each thread,
- writes the briefing at the top of each overview,
- drafts replies and nudges for you to review and send yourself,
- turns transcripts into a summary, decisions, action items and dated follow-ups,
- answers questions about past meetings.

With a key, the text of emails that may need a reply and the text of your transcripts is sent to Anthropic's API, and Anthropic bills you for that usage. Without a key nothing leaves your computer. You can pick the model in Settings; cheaper models are listed there.

## Meetings

- **Pop-up:** when a calendar event starts (one minute before, by default), Pinger asks whether to take notes. Saying yes opens the recorder with the meeting's title and attendees filled in.
- **Live transcript:** works in Chrome and Edge. It transcribes what your microphone hears — everyone when you are on speakers, only you when you are on headphones. On headphones, add the meeting's own transcript afterwards. No audio is stored. The speech-to-text itself is done by the browser's speech service (Google's in Chrome, Microsoft's in Edge).
- **Add a transcript:** paste text or upload `.vtt`, `.docx`, `.srt` or `.txt`.
- Tell people you are transcribing. In many places you need everyone's consent to record a conversation.

## Share it

Each person runs their own copy; their mail, meetings and keys stay on their own computer.

1. Send them this folder (zip it; you can leave out `node_modules`) or a link to the repository.
2. They install Node.js and start it as above.
3. They connect their own email in setup.

Your personal data is **not** in this folder — it lives in your user profile (the exact path is shown in Settings → Data) — so sharing the folder shares none of it.

## Privacy and security

- Pinger listens on `localhost` only and refuses requests that do not come from its own page.
- Mail access is read-only: the Outlook permissions are `Mail.Read` and `Calendars.Read`; IMAP mailboxes are opened read-only.
- Sign-in tokens, app passwords and your AI key are stored unencrypted in Pinger's data folder, readable only by your user account. Anyone who can log in as you on this computer can read them; **Settings → Data → Delete all data** removes everything.
- Reply drafts are never sent by Pinger. You copy them or open them in your mail app.

## Limits

- Pinger only works while it is running on your computer. It is not a cloud service and does not ping your phone.
- It looks at the last 14 days of mail by default.
- Outlook and Gmail/IMAP connections are covered by automated tests against simulated servers; live transcription depends on your browser.
- It is not an Outlook add-in: it does not appear inside the Outlook desktop app. Use the side panel (Outlook on the web) or the mini window (any mail app) to keep it next to your mail.
- The side panel and mini window change where Pinger is shown. Reading Outlook mail still needs the one-time Microsoft registration above.

## Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `PINGER_PORT` | `4317` | Port to listen on. If you change it, use the same port in the Outlook redirect URI. |
| `PINGER_DATA_DIR` | per-user data folder | Where Pinger stores its database. |
| `ANTHROPIC_API_KEY` | – | Used if no key is saved in Settings. |

`node bin/pinger.js --demo` starts with the sample mailbox added; `--no-open` skips opening the browser.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm start
```

- `src/core/` — triage rules, mail sync, overview, follow-ups, meeting memory, calendar.
- `src/providers/` — Outlook (Microsoft Graph), Outlook desktop app on Windows (PowerShell + COM), IMAP, `.ics` calendars, sample data.
- `src/ai/` — the Claude API client and prompts.
- `src/scheduler.js` — the loop that syncs mail and fires pings.
- `public/` — the interface (Preact, no build step).
- `extension/` — the Chrome/Edge side-panel extension (a frame around the compact view).
- `test/` — `node --test` suites; no network access needed.
