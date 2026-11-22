// The mini window: Pinger in a small window you can keep next to (or on top of) your mail app.

import { render } from 'preact';
import { html, store, toast, update } from './lib.js';
import { MiniPanel } from './views/mini.js';

/**
 * Open the mini panel. In Chrome and Edge it is a Document Picture-in-Picture window, which
 * stays on top of every other window; elsewhere it is an ordinary small browser window.
 */
export async function popOut() {
  if (store.mini && !store.mini.closed) {
    store.mini.focus?.();
    return;
  }
  if ('documentPictureInPicture' in window) {
    try {
      const pip = await window.documentPictureInPicture.requestWindow({ width: 360, height: 620 });
      const doc = pip.document;
      doc.title = 'Pinger';
      doc.documentElement.lang = 'en';
      const scheme = doc.createElement('meta');
      scheme.name = 'color-scheme';
      scheme.content = 'light dark';
      const css = doc.createElement('link');
      css.rel = 'stylesheet';
      css.href = new URL('/styles.css', location.href).href;
      doc.head.append(scheme, css);
      const root = doc.createElement('div');
      doc.body.append(root);
      render(html`<${MiniPanel} />`, root);
      pip.addEventListener('pagehide', () => {
        render(null, root);
        update({ mini: null });
      });
      update({ mini: pip });
      return;
    } catch {
      /* not allowed in this context — fall back to a normal window */
    }
  }
  const win = window.open('/#/mini', 'pinger-mini', 'popup,width=360,height=620');
  if (!win) toast('The browser blocked the mini window. Allow pop-ups for this page.', { kind: 'error' });
  else update({ mini: win });
}

/** True while the always-on-top panel (not the fallback window) is showing. */
export const floatingPanelOpen = () =>
  !!store.mini && !store.mini.closed && 'documentPictureInPicture' in window && window.documentPictureInPicture.window === store.mini;
