// Outlook on the web, as read by Pinger's browser extension. The extension pushes what it sees
// (see src/core/outlook-web.js); this provider serves those stored items to the normal mail sync.

import { itemsToMessages } from '../core/owa-parse.js';
import { all } from '../db.js';
import { parseJson } from '../util.js';

export function createOutlookWebProvider(account) {
  return {
    async fetchMessages({ since }) {
      const items = all('SELECT data FROM web_items WHERE account_id = ?', account.id)
        .map((r) => parseJson(r.data, null))
        .filter(Boolean);
      // The stored items are the whole truth for this account, so the window can be mirrored exactly.
      return { messages: itemsToMessages(items, { since }), complete: true };
    },
  };
}
