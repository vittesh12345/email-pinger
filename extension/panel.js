// The side panel is a frame around Pinger's own compact view. Pinger itself runs on this
// computer; if it is not running, say so and keep checking.

const BASE = 'http://localhost:4317';
const frame = document.getElementById('app');
const offline = document.getElementById('offline');
let connected = false;
let timer = null;

async function isRunning() {
  try {
    const res = await fetch(`${BASE}/api/health`, { cache: 'no-store' });
    return res.ok && (await res.json()).app === 'pinger';
  } catch {
    return false;
  }
}

async function check() {
  if (connected) return;
  if (await isRunning()) {
    connected = true;
    clearInterval(timer);
    frame.src = `${BASE}/#/mini`;
    frame.hidden = false;
    offline.hidden = true;
  } else {
    frame.hidden = true;
    offline.hidden = false;
  }
}

document.getElementById('retry').addEventListener('click', check);
timer = setInterval(check, 4000);
check();
