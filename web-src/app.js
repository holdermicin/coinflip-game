import { autoConnect } from '@unicitylabs/sphere-sdk/connect/browser';

const TESTNET2 = { id: 4, name: 'testnet2' };
const WALLET_URL = 'https://sphere.unicity.network';
const HOUSE_NAMETAG = '@coinfliphouse'; // must match NAMETAG in house-bot/.env

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $('log');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.prepend(line);
};

let client = null;
let uctCoinId = null;
let selectedCall = 'heads';

function setConnected(identity) {
  $('status').textContent = 'Connected';
  $('status').className = 'status connected';
  $('identity').textContent = identity?.nametag ? `@${identity.nametag}` : (identity?.directAddress || 'unknown');
  $('connectBtn').style.display = 'none';
  $('game').style.display = 'block';
}

function setDisconnected() {
  $('status').textContent = 'Not connected';
  $('status').className = 'status disconnected';
  $('identity').textContent = '—';
  $('connectBtn').style.display = 'inline-block';
  $('game').style.display = 'none';
}

async function connect(silent) {
  try {
    log(silent ? 'Checking for an existing approved connection…' : 'Requesting connection to your Sphere wallet…');
    const result = await autoConnect({
      dapp: {
        name: 'Coin Flip UCT',
        description: 'Call heads or tails, stake a little testnet UCT, double it if you win.',
        url: window.location.origin + window.location.pathname,
      },
      walletUrl: WALLET_URL,
      network: TESTNET2,
      silent,
    });
    client = result.client;
    setConnected(result.connection.identity);
    log(`Connected via ${result.transport} as ${result.connection.identity?.nametag ? '@' + result.connection.identity.nametag : 'wallet'}.`);

    client.on('identity:changed', (data) => { log('Wallet identity changed.'); setConnected(data); });
    client.on('wallet:locked', () => { log('Wallet locked.'); setDisconnected(); });

    await refreshBalance();
  } catch (err) {
    if (!silent) log(`Connection failed: ${err.message || err}`);
    setDisconnected();
  }
}

async function refreshBalance() {
  if (!client) return;
  try {
    const assets = await client.query('sphere_getAssets');
    const uct = Array.isArray(assets) ? assets.find((a) => a.symbol === 'UCT') : null;
    if (uct?.coinId) uctCoinId = uct.coinId;
    $('balance').textContent = uct ? `${(Number(uct.totalAmount) / 1e18).toFixed(4)} UCT` : '0 UCT';
  } catch (err) {
    log(`Could not read balance: ${err.message || err}`);
  }
}

function selectCall(call) {
  selectedCall = call;
  $('callHeads').classList.toggle('active', call === 'heads');
  $('callTails').classList.toggle('active', call === 'tails');
}

async function flip() {
  if (!client) return;
  if (!uctCoinId) {
    log('Still resolving UCT coin ID — click "Refresh balance" first.');
    return;
  }
  const stake = $('stake').value.trim();
  if (!stake || Number(stake) <= 0) {
    log('Enter a stake amount first.');
    return;
  }

  try {
    log(`Telling the house you're calling ${selectedCall.toUpperCase()}…`);
    await client.intent('dm', { to: HOUSE_NAMETAG, message: selectedCall });

    log(`Placing bet: ${stake} UCT on ${selectedCall.toUpperCase()}…`);
    const amountSmallestUnit = BigInt(Math.round(Number(stake) * 1e18)).toString();
    const result = await client.intent('send', {
      to: HOUSE_NAMETAG,
      amount: amountSmallestUnit,
      coinId: uctCoinId,
    });
    log(`Bet placed (${result?.status || 'submitted'}). Check your Sphere chat with ${HOUSE_NAMETAG} for the result in a few seconds!`);

    // Poll balance a few times so the UI reflects the payout/refund once it lands
    let checks = 0;
    const poll = setInterval(async () => {
      checks += 1;
      await refreshBalance();
      if (checks >= 6) clearInterval(poll); // ~30s of polling
    }, 5000);
  } catch (err) {
    log(`Bet failed or was rejected: ${err.message || err}`);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setDisconnected();
  selectCall('heads');
  $('connectBtn').addEventListener('click', () => connect(false));
  $('refreshBtn').addEventListener('click', refreshBalance);
  $('callHeads').addEventListener('click', () => selectCall('heads'));
  $('callTails').addEventListener('click', () => selectCall('tails'));
  $('flipBtn').addEventListener('click', flip);

  connect(true); // silent auto-connect if already approved (e.g. inside Sphere iframe)
});
