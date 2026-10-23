// /privacy — fills live numbers (anonymity set size, key end date).
import './site.js';
import { startLive, fillRedeemDate } from './live.js';

startLive(60000);
fillRedeemDate();
