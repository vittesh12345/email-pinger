// Clicking the toolbar icon opens Pinger in the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The Outlook reader (outlook-reader.js) hands its snapshots here; this forwards them to the
// Pinger app on this computer. Only Outlook pages, through this extension's own content script.
const PINGER = 'http://localhost:4317';
const OUTLOOK_ORIGINS = new Set([
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://outlook.live.com',
  'https://outlook.cloud.microsoft',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'pinger:outlook' || sender.id !== chrome.runtime.id) return false;
  const origin = sender.origin || (sender.url ? new URL(sender.url).origin : '');
  if (!OUTLOOK_ORIGINS.has(origin)) return false;
  fetch(`${PINGER}/api/outlook-web/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message.payload || {}),
  })
    .then((res) => (res.ok ? res.json() : { offline: false, status: res.status }))
    .catch(() => ({ offline: true }))
    .then(sendResponse);
  return true; // answer asynchronously
});
