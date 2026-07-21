import 'dotenv/config';
import fs from 'fs';
import crypto from 'crypto';
import { Sphere, isSphereError } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const NAMETAG = process.env.NAMETAG || 'andutcoinflip';
const MIN_STAKE = Number(process.env.MIN_STAKE || '1');   // UCT
const MAX_STAKE = Number(process.env.MAX_STAKE || '10');  // UCT
const PAYOUT_MULTIPLIER = Number(process.env.PAYOUT_MULTIPLIER || '2'); // 2x on win
const DAILY_PAYOUT_CAP_HUMAN = Number(process.env.DAILY_PAYOUT_CAP || '500'); // max UCT paid out per day

// --- Daily payout ledger (persisted to disk, resets at midnight) ---
const LEDGER_PATH = './wallet-data/payout-ledger.json';
function todayKey() { return new Date().toISOString().slice(0, 10); }
function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    if (raw.date === todayKey()) return raw;
  } catch (_) {}
  return { date: todayKey(), totalPaidOut: 0 };
}
function saveLedger(ledger) {
  fs.mkdirSync('./wallet-data', { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger));
}

function humanToSmallest(n) {
  return BigInt(Math.round(n * 1e18)).toString();
}
function smallestToHuman(s) {
  return Number(BigInt(s)) / 1e18;
}

// Sphere Connect's "send" intent does not forward a custom memo field through to the
// settled transfer, so we can't rely on memo to know the player's call. Instead, the
// player DMs their call ("heads"/"tails") first, then sends the stake — we correlate
// the two by sender identity, with a short expiry so stale calls don't apply to a later bet.
const pendingCalls = new Map(); // key: senderNametag or senderPubkey -> { call, expiresAt }
const PENDING_CALL_TTL_MS = 2 * 60 * 1000; // 2 minutes

// --- Processed-deposit tracker (persisted) so getHistory()-based detection never double-processes ---
const PROCESSED_PATH = './wallet-data/processed-deposits.json';
function loadProcessed() {
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8')));
  } catch (_) {
    return new Set();
  }
}
function saveProcessed(set) {
  fs.mkdirSync('./wallet-data', { recursive: true });
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify([...set]));
}
const processedDeposits = loadProcessed();

async function main() {
  console.log('Starting Coin Flip house bot...');

  const base = createNodeProviders({
    network: 'testnet',
    dataDir: './wallet-data',
    tokensDir: './tokens',
    oracle: { apiKey: process.env.ORACLE_API_KEY || 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },
  });

  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: `${NAMETAG}-device`,
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet',
    autoGenerate: true,
    communications: { cacheMessages: false },
  });

  if (created && generatedMnemonic) {
    console.log('=================================================================');
    console.log('NEW HOUSE WALLET CREATED — SAVE THIS RECOVERY PHRASE SOMEWHERE SAFE:');
    console.log(generatedMnemonic);
    console.log('=================================================================');
  }

  try {
    const available = await sphere.isNametagAvailable(NAMETAG);
    if (available) {
      await sphere.registerNametag(NAMETAG);
      console.log(`Registered nametag: @${NAMETAG}`);
    } else {
      console.log(`Nametag @${NAMETAG} already bound to this wallet.`);
    }
  } catch (err) {
    console.warn('Nametag registration skipped/failed:', err.message);
  }

  console.log('House identity:', sphere.identity?.nametag ?? sphere.identity?.address);

  sphere.communications.onDirectMessage((msg) => {
    const key = msg.senderNametag || msg.senderPubkey;
    if (!key) return;
    const call = (msg.content || '').trim().toLowerCase();
    if (call === 'heads' || call === 'tails') {
      pendingCalls.set(key, { call, expiresAt: Date.now() + PENDING_CALL_TTL_MS, registeredAt: Date.now() });
      console.log(`Registered call "${call}" from ${msg.senderNametag ? '@' + msg.senderNametag : key}`);
    }
  });

  await sphere.payments.receive(undefined, (t) => processTransfer(t).catch((e) => console.error('processTransfer error:', e)));
  console.log('Current balance:', await sphere.payments.getAssets());
  await scanHistoryForDeposits();

  async function processTransfer(transfer) {
    let key = transfer.senderNametag || transfer.senderPubkey;
    const uctToken = transfer.tokens?.find((t) => t.symbol === 'UCT');
    if (!uctToken) return; // ignore non-UCT deposits

    // Sphere Connect's "send" intent sometimes settles without carrying sender identity
    // through to the recipient (unlike direct SDK-to-SDK sends). When that happens, fall
    // back to attributing the deposit to the oldest still-valid pending call — since the
    // player already told us who they are via DM (which always carries proper identity),
    // and only one bet is expected in flight per player at a time for this demo.
    if (!key) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, v] of pendingCalls.entries()) {
        if (v.expiresAt > Date.now() && v.registeredAt < oldestTs) {
          oldestTs = v.registeredAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        console.log(`Deposit had no resolvable sender identity — attributing it to the oldest pending call, from ${oldestKey}.`);
        key = oldestKey;
      } else {
        console.log('Ignoring a deposit with no resolvable sender identity and no pending call to match it to (likely a stale/legacy transfer).');
        return;
      }
    }

    const from = key.startsWith('npub') || key.length > 30 ? key : `@${key}`; // nametags are short; pubkeys/npubs are long
    const stakeHuman = smallestToHuman(uctToken.amount);

    const pending = pendingCalls.get(key);
    const call = pending && pending.expiresAt > Date.now() ? pending.call : null;
    pendingCalls.delete(key);

    console.log(`Bet received from ${from}: ${stakeHuman} UCT, call="${call || '(none)'}"`);

    // Validate call
    if (!call) {
      await refund(from, uctToken.amount, 'No valid "heads"/"tails" call found for this stake (DM your call *before* sending UCT next time). Refunding your stake.');
      return;
    }

    // Validate stake range
    if (stakeHuman < MIN_STAKE || stakeHuman > MAX_STAKE) {
      await refund(from, uctToken.amount, `Stake must be between ${MIN_STAKE} and ${MAX_STAKE} UCT. Refunding your stake.`);
      return;
    }

    // Check daily payout cap before committing to a possible payout
    const ledger = loadLedger();
    const potentialPayout = stakeHuman * PAYOUT_MULTIPLIER;
    if (ledger.totalPaidOut + potentialPayout > DAILY_PAYOUT_CAP_HUMAN) {
      await refund(from, uctToken.amount, "House has hit its daily payout limit. Refunding your stake — try again tomorrow!");
      return;
    }

    // Flip the coin — cryptographically random, unbiased 50/50
    const result = crypto.randomInt(2) === 0 ? 'heads' : 'tails';
    const won = result === call;
    console.log(`Coin landed on ${result}. ${from} called ${call}. ${won ? 'WIN' : 'LOSE'}`);

    if (won) {
      const payoutHuman = stakeHuman * PAYOUT_MULTIPLIER;
      try {
        const send = await sphere.payments.send({
          recipient: from,
          amount: humanToSmallest(payoutHuman),
          coinId: 'UCT',
          memo: `Coin landed on ${result} — you won ${payoutHuman} UCT!`,
        });
        if (send.status === 'completed') {
          ledger.totalPaidOut += payoutHuman;
          saveLedger(ledger);
        }
        await sphere.communications.sendDM(from, `🎉 Coin landed on ${result.toUpperCase()} — you WON! Sent you ${payoutHuman} UCT.`);
      } catch (err) {
        console.error('Payout failed:', err.message);
        await sphere.communications.sendDM(from, `🎉 Coin landed on ${result.toUpperCase()} — you won, but payout failed on my end (${err.message}). Please contact the dev.`);
      }
    } else {
      await sphere.communications.sendDM(from, `💀 Coin landed on ${result.toUpperCase()} — you lost this round. Better luck next time!`);
    }
  }

  async function refund(from, amountSmallest, reasonMsg) {
    if (!from) {
      console.log('Skipping refund — no resolvable recipient identity.');
      return;
    }
    try {
      await sphere.payments.send({ recipient: from, amount: amountSmallest, coinId: 'UCT', memo: 'Refund' });
      await sphere.communications.sendDM(from, `↩️ ${reasonMsg}`);
    } catch (err) {
      console.error('Refund failed:', err.message);
    }
  }

  async function scanHistoryForDeposits() {
    let entries;
    try {
      entries = sphere.payments.getHistory();
    } catch (err) {
      console.warn('getHistory() failed:', err.message);
      return;
    }
    const newDeposits = entries.filter(
      (e) => e.type === 'RECEIVED' && e.symbol === 'UCT' && !processedDeposits.has(e.dedupKey)
    );
    for (const entry of newDeposits) {
      processedDeposits.add(entry.dedupKey);
      await processTransfer({
        senderNametag: entry.senderNametag,
        senderPubkey: entry.senderPubkey,
        memo: entry.memo,
        tokens: [{ symbol: 'UCT', amount: entry.amount }],
      }).catch((e) => console.error('processTransfer error:', e));
    }
    if (newDeposits.length) saveProcessed(processedDeposits);
  }

  setInterval(async () => {
    try {
      const { transfers } = await sphere.payments.receive(undefined, (t) => processTransfer(t).catch((e) => console.error('processTransfer error:', e)));
      await scanHistoryForDeposits();
      console.log(`[poll] receive()=${transfers?.length || 0}, history scan done.`);
    } catch (err) {
      console.warn('Polling failed:', err.message);
    }
  }, 5000);

  console.log(`House bot is live. DM "heads" or "tails" to @${NAMETAG}, then send ${MIN_STAKE}-${MAX_STAKE} UCT within 2 minutes to play.`);
  const startupLedger = loadLedger();
  console.log(`Today's payout so far: ${startupLedger.totalPaidOut}/${DAILY_PAYOUT_CAP_HUMAN} UCT.`);

  process.on('SIGINT', () => {
    console.log('Shutting down house bot...');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error starting house bot:', err);
  process.exit(1);
});
