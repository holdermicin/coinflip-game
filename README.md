# Coin Flip UCT 🪙

A simple provably-random coin flip game built on the **Unicity Sphere SDK**, running on **testnet2**.

## How it works

1. Player connects their Sphere wallet via **Sphere Connect** (the web app in `web-src/` / `docs/`).
2. Player picks **Heads** or **Tails** and a stake (1–10 UCT).
3. The web app sends the stake to the house wallet (`@andutcoinflip`) with a memo of `"heads"` or `"tails"`, using `client.intent('send', ...)`.
4. The **house bot** (`house-bot/`) receives the payment, flips a cryptographically random coin (`crypto.randomInt`), and:
   - **Win** → sends back `2x` the stake automatically, plus a DM with the result.
   - **Lose** → keeps the stake, sends a DM with the result.
   - **Invalid bet** (bad memo or out-of-range stake) → refunds automatically.
5. The house bot enforces a **daily payout cap** (default 500 UCT/day) to protect its bankroll, persisted to disk so it survives restarts.

## Project structure

```
coinflip-game/
├── house-bot/        # Node.js bot that settles bets (the "house")
│   ├── index.js
│   ├── package.json
│   └── .env.example
├── web-src/           # Frontend source (Sphere Connect dApp)
│   ├── index.html
│   └── app.js
└── docs/               # Built/bundled frontend, served via GitHub Pages
    ├── index.html
    └── bundle.js
```

## Running the house bot

```bash
cd house-bot
npm install
cp .env.example .env   # adjust NAMETAG, stake range, payout cap as needed
npm start
```

The bot needs a starting UCT balance to pay out winners — fund `@andutcoinflip` from your own wallet or the testnet faucet.

## Running the web app

The `docs/` folder is a static, pre-bundled build — just serve it (e.g. via GitHub Pages) or open `docs/index.html` in a local dev server. It uses `@unicitylabs/sphere-sdk/connect/browser`'s `autoConnect` to detect the best available transport (iframe / extension / popup) and connect to the player's Sphere wallet.

To rebuild the bundle after editing `web-src/app.js`:

```bash
npx esbuild web-src/app.js --bundle --format=esm --outfile=docs/bundle.js --minify
```

## Fairness

The coin flip uses Node's `crypto.randomInt(2)`, a cryptographically secure random source — not `Math.random()`. The house does not know the player's call before generating the result (the call arrives with the stake in the same transfer).

## Tech stack

- `@unicitylabs/sphere-sdk` — wallet + payments + messaging (house bot)
- `@unicitylabs/sphere-sdk/connect/browser` — Sphere Connect dApp integration (web app)
- Network: testnet2
