import { saveAccountConfig } from '../accounts.js';
import { getSettings } from '../settings.js';
import { createDemoProvider } from './demo.js';
import { createImapProvider } from './imap.js';
import { createOutlookDesktopProvider } from './outlook-desktop.js';
import { createOutlookProvider } from './outlook.js';

/** @returns {{fetchMessages: Function, fetchEvents?: Function}} */
export function createProvider(account) {
  switch (account.kind) {
    case 'outlook':
      return createOutlookProvider(account, { saveConfig: (cfg) => saveAccountConfig(account.id, cfg) });
    case 'outlook_desktop':
      return createOutlookDesktopProvider(account);
    case 'imap':
      return createImapProvider(account);
    case 'demo':
      return createDemoProvider(account, { profileName: getSettings().profile.name });
    default:
      throw new Error(`Unknown account type "${account.kind}"`);
  }
}
