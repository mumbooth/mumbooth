// "/" — hero trial chat + live tally.
import './site.js';
import { createChat } from './chat.js';
import { startLive, onStatus, fillRedeemDate, priceLine } from './live.js';
import { $$ } from './util.js';

const trialRoot = document.getElementById('trial');
if (trialRoot) createChat(trialRoot, { kind: 'trial', title: 'Booth 00 · free trial' });

startLive();
fillRedeemDate();
onStatus((status) => {
  const line = priceLine(status);
  if (line) for (const n of $$('[data-price-line]')) n.textContent = line;
});
