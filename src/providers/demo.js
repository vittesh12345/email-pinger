// A made-up mailbox and calendar, so anyone can try Pinger before connecting a real account.
// Everything is anchored to the moment the demo account was added, so it always looks current.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEMO_EMAIL = 'you@example.com';

const p = (name, email) => ({ name, email });
const PRIYA = p('Priya Raman', 'priya.raman@northwind.example');
const MARCUS = p('Marcus Lee', 'marcus.lee@acme.example');
const DANA = p('Dana Whitfield', 'dana.whitfield@acme.example');
const JORDAN = p('Jordan Kim', 'jordan.kim@acme.example');
const SAM = p('Sam Okafor', 'sam.okafor@gmail.example');
const ELENA = p('Elena Petrova', 'elena@brightside.example');
const TOM = p('Tom Becker', 'tom@printworks.example');
const CHRIS = p('Chris Alvarez', 'chris.alvarez@acme.example');
const HANNAH = p('Hannah Schultz', 'hannah@riverbend.example');
const RAVI = p('Ravi Shah', 'ravi.shah@ledgerline.example');

export function demoIdentity(profileName) {
  const name = (profileName || '').trim() || 'Alex Morgan';
  return { name, first: name.split(/\s+/)[0], me: p(name, DEMO_EMAIL) };
}

function demoMessages(seed, profileName) {
  const { first, me } = demoIdentity(profileName);
  const at = (msAgo) => new Date(seed - msAgo).toISOString();
  let n = 0;
  const msg = (thread, from, to, cc, msAgo, subject, body, extra = {}) => ({
    providerId: `demo-${++n}`,
    threadKey: `demo:${thread}`,
    from,
    to,
    cc,
    subject,
    body,
    sentAt: at(msAgo),
    isRead: msAgo > 6 * HOUR,
    importance: 'normal',
    webLink: null,
    folderHint: from === me ? 'sent' : 'inbox',
    ...extra,
  });

  return [
    msg('renewal', PRIYA, [me], [], 5 * HOUR, 'Contract renewal — need your answer by Friday',
      `Hi ${first},\n\nWe're finalizing the renewal paperwork on our side. Can you confirm whether you want to keep the 40-seat plan or move up to 60? I need your answer by Friday to lock in the current pricing.\n\nThanks,\nPriya`,
      { importance: 'high' }),

    msg('roadmap', MARCUS, [me], [DANA], 26 * HOUR, 'Q4 roadmap draft — feedback?',
      `${first},\n\nI've attached the Q4 roadmap draft. Could you look at the hiring section and let me know if the timeline is realistic? It would be good to have your thoughts before Thursday's leadership sync.\n\nMarcus`),

    msg('mockups', me, [JORDAN], [], 2 * DAY, 'Onboarding mockups v3',
      `Hi Jordan,\n\nHere are the v3 mockups for the onboarding flow. Let me know what you think.\n\n${first}`),
    msg('mockups', JORDAN, [me], [], 20 * HOUR, 'Re: Onboarding mockups v3',
      `These look great! One question — do we have the dark mode variants yet? The dev team is asking so they can start on theming.\n\nJordan\n\nOn Tue, ${first} wrote:\n> Here are the v3 mockups for the onboarding flow. Let me know what you think.`),

    msg('coffee', SAM, [me], [], 3 * DAY, 'Coffee next week?',
      `Hey ${first}! It's been ages. Are you free for a coffee next week? I'm around Tuesday or Wednesday afternoon.\n\nSam`),

    msg('speaker', HANNAH, [me], [], 6 * DAY, 'Speaking at our March event',
      `Hi ${first},\n\nFollowing up on my note from last week — are you still interested in speaking at our March event? We need to confirm speakers soon, so please let me know either way.\n\nBest,\nHannah`),

    msg('vendors', DANA, [MARCUS], [me], 8 * HOUR, 'Vendor comparison',
      `Marcus — attached is the vendor comparison. I'll walk everyone through it on Thursday.\n\nDana`),

    msg('newsletter', p('The Weekly Brief', 'newsletter@weeklybrief.example'), [me], [], 3 * HOUR, 'This week: 5 trends shaping remote work',
      `Top stories this week...\n\nYou are receiving this email because you signed up at weeklybrief.example. Unsubscribe | Manage your preferences`,
      { headers: { listUnsubscribe: true } }),

    msg('build', p('Buildbot', 'notifications@ci.example'), [me], [], 2 * HOUR, 'Build #4821 passed',
      `Build #4821 on main passed in 6m 12s.\n\nThis is an automated message. Do not reply to this email.`),

    msg('receipt', p('Cloudly Billing', 'billing@cloudly.example'), [me], [], 30 * HOUR, 'Your receipt for November',
      `Thanks for your payment of $49.00. This is an automated receipt for your records.`),

    msg('proposal', me, [ELENA], [], 4 * DAY, 'Proposal for the spring campaign',
      `Hi Elena,\n\nAttached is the proposal we discussed. Could you let me know whether the budget on page 3 works for your team? Happy to jump on a call if that's easier.\n\nBest,\n${first}`),

    msg('quote', me, [TOM], [], 1 * DAY, 'Updated quote for 500 units',
      `Hi Tom,\n\nCan you send over the updated quote for 500 units when you get a chance? We'd like to place the order this month.\n\nThanks,\n${first}`),

    msg('intro', me, [RAVI], [], 5 * DAY, 'Intro call about the finance integration',
      `Hi Ravi,\n\nMarcus suggested I reach out. Would you be open to a 20-minute call next week to talk through the finance integration?\n\n${first}`),

    msg('invoice', me, [CHRIS], [], 2 * DAY, 'Invoice for October',
      `Hi Chris, the October invoice is attached.\n\n${first}`),
    msg('invoice', CHRIS, [me], [], 1 * DAY, 'Re: Invoice for October', `Got it, thanks!`),

    msg('designreview', DANA, [me], [], 9 * HOUR, 'Accepted: Design review', '', { isMeetingMessage: true }),

    msg('thanks', PRIYA, [me], [], 3 * DAY, 'Onboarding docs', `Here are the onboarding docs you asked for.\n\nPriya`),
    msg('thanks', me, [PRIYA], [], 3 * DAY - HOUR, 'Re: Onboarding docs', `Thanks, Priya!`),
  ];
}

function demoEvents(seed) {
  const ev = (id, title, startOffset, minutes, attendees) => ({
    providerId: `demo-event-${id}`,
    title,
    startAt: new Date(seed + startOffset).toISOString(),
    endAt: new Date(seed + startOffset + minutes * 60_000).toISOString(),
    attendees,
    joinUrl: `https://meet.example/${id}`,
    location: null,
    isAllDay: false,
    isCancelled: false,
    declined: false,
  });
  return [
    ev('northwind-checkin', 'Client check-in — Northwind', -3 * HOUR, 30, [PRIYA]),
    // Starts two minutes after the demo is added, so the "take notes?" pop-up shows up right away.
    ev('product-sync', 'Weekly product sync', 2 * 60_000, 30, [MARCUS, DANA, JORDAN]),
    ev('one-on-one', '1:1 with Marcus', 3 * HOUR, 30, [MARCUS]),
    ev('design-review', 'Design review', DAY + HOUR, 45, [DANA, JORDAN]),
  ];
}

export function createDemoProvider(account, { profileName } = {}) {
  const seed = account.config?.seedAt || Date.now();
  return {
    async fetchMessages() {
      return { messages: demoMessages(seed, profileName), complete: true };
    },
    async fetchEvents({ from, to }) {
      return demoEvents(seed).filter((e) => new Date(e.startAt) >= from && new Date(e.startAt) <= to);
    },
  };
}

export function sampleTranscript(profileName) {
  const { name } = demoIdentity(profileName);
  return {
    title: 'Weekly product sync',
    attendees: ['Marcus Lee', 'Dana Whitfield', 'Jordan Kim', name],
    transcript: `Marcus Lee: Okay, let's get started. Main topic today is the onboarding redesign and where we stand for the December release.
Jordan Kim: Design is basically done. The one gap is the dark mode variants. I can have those by Wednesday.
${name}: Great. I'll send the final copy for the welcome screens to Jordan by end of day tomorrow so that doesn't block you.
Dana Whitfield: On the vendor side, I'm still waiting on the analytics contract. I'll chase legal and get back to ${name.split(' ')[0]} by Friday.
Marcus Lee: Do we have a decision on the launch date?
${name}: I'd propose December 9th. That gives QA a full week.
Marcus Lee: Agreed, let's lock December 9th.
Jordan Kim: One open question, are we localizing for the German market at launch or after?
Marcus Lee: I don't know yet. ${name.split(' ')[0]}, can you check with the sales team and report back at the next sync?
${name}: Yes, I'll ask Priya's team this week.
Dana Whitfield: Also, the customer webinar. Someone needs to send the invite list to marketing.
${name}: I'll do that. I'll email the list to marketing by Thursday.
Marcus Lee: Perfect. I'll update the roadmap doc with the new date and share it with leadership.
Jordan Kim: Should we do a design review before the dev handoff?
Marcus Lee: Yes. Dana, can you set that up for early next week?
Dana Whitfield: Will do.
Marcus Lee: Anything else? No? Thanks everyone.`,
  };
}
