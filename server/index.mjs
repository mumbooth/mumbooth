// Bootstrap. Production: systemd loads /etc/mumbooth.env. Dev: `npm run dev` (mock RPC + mock model + serves ../web).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createContext } from './context.mjs';
import { buildApp } from './app.mjs';
import { createRealRpc, createMockRpc } from './rpc.mjs';
import { createAnthropicModel, createMockModel, createOpenRouterModel } from './model.mjs';
import { createTrial } from './trial.mjs';
import { loadKeys } from './keys.mjs';
import { sweepSpent } from './stats.mjs';
import { openDb } from './db.mjs';

const config = loadConfig();
if (!config.mock && !/^0x[0-9a-f]{40}$/.test(config.treasury)) { console.error('TREASURY (0x address) is required'); process.exit(1); }
if (!config.modelMock && !config.openrouterKey && !config.anthropicKey) { console.error('OPENROUTER_API_KEY or ANTHROPIC_API_KEY is required (or MODEL_MODE=mock)'); process.exit(1); }
if (config.mock && process.env.MOCK_FRESH === '1') fs.rmSync(config.dataDir, { recursive: true, force: true });

const db = openDb(path.join(config.dataDir, 'mumbooth.db'));
const rpc = config.mock ? createMockRpc({ treasury: config.treasury, priceWei: config.priceWei }) : createRealRpc({ urls: config.rpcUrls, chainId: config.chainId });
const model = config.modelMock ? createMockModel()
  : config.openrouterKey ? createOpenRouterModel({ apiKey: config.openrouterKey })
  : createAnthropicModel({ apiKey: config.anthropicKey });
const trial = createTrial({ perDay: 3, cap: config.trialDailyCap });
const keys = await loadKeys({ dir: path.join(config.dataDir, 'keys'), currentId: config.currentKey, issueDays: config.issueDays, redeemDays: config.redeemDays, log: (m) => console.log(m) });
const ctx = createContext({ config, db, rpc, keys, model, trial });
const app = await buildApp(ctx);

setInterval(() => { try { sweepSpent(ctx); } catch { app.log.error('sweep failed'); } }, 3600_000).unref();
await app.listen({ port: config.port, host: config.host });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await app.close(); db.close(); process.exit(0); });
