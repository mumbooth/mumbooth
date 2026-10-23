// Environment -> config. Every value has a safe default so tests and `npm run dev` need no .env.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODELS = { fast: { id: 'claude-haiku-5-5', coupons: 1, maxTokens: 1024, maxChars: 24_000, effort: 'low' }, deep: { id: 'claude-sonnet-5-5', coupons: 3, maxTokens: 2048, maxChars: 48_000, effort: 'medium' } };
export const TRIAL = { perDay: 3, maxTokens: 512, maxChars: 6000, maxMessages: 6 };
export const LIMITS = { maxMessages: 40, maxContent: 8000 };
export const MOCK_TREASURY = '0x1111111111111111111111111111111111111111';

const big = (v) => (v === undefined || v === '' || v === 'null' ? null : BigInt(v));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env = process.env) {
  const mock = env.RPC_MODE === 'mock';
  return {
    port: num(env.PORT, 4930),
    host: env.HOST || '127.0.0.1',
    mock,
    modelMock: env.MODEL_MODE === 'mock',
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    serveWeb: env.SERVE_WEB === '1',
    webDir: path.resolve(here, '../web'),
    dataDir: env.DATA_DIR || (mock ? path.join(here, 'data', 'mock') : '/var/lib/mumbooth'),
    tokenJsonPath: env.TOKEN_JSON || path.resolve(here, '../web/token.json'),
    rpcUrls: (env.RPC_URL || 'https://robinhood-rpc.publicnode.com').split(',').map((s) => s.trim()).filter(Boolean),
    chainId: 4663,
    explorer: env.EXPLORER || 'https://robinhoodchain.blockscout.com',
    treasury: (env.TREASURY || (mock ? MOCK_TREASURY : '')).toLowerCase(),
    priceWei: big(env.PRICE_WEI) ?? 20_000_000_000_000n, // 0.00002 ETH
    maxPack: num(env.MAX_PACK, 500),
    holdPerDay: num(env.HOLD_PER_DAY, 5),
    holdMin: big(env.HOLD_MIN),               // whole tokens
    tokensPerCoupon: big(env.TOKENS_PER_COUPON), // whole tokens
    trialDailyCap: num(env.TRIAL_DAILY_CAP, 1500),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    openrouterKey: env.OPENROUTER_API_KEY || '',
    currentKey: env.CURRENT_KEY || 'k1',
    issueDays: 30,
    redeemDays: 60,
    statusTtlMs: 15_000,
    logLevel: env.LOG_LEVEL || 'info',
  };
}
