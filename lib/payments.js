// Payment provider abstraction for Raahi NOW.
//
// EVERY payment in the app goes through this file. Handlers in lib/api.js
// call getProvider().createCharge(...) — they never record a payment or
// talk to a processor directly. That is what makes connecting a real
// crypto processor later a configuration change + one new provider file,
// not a rewrite.
//
// Provider interface (implement these two functions):
//   createCharge({ userId, kind, amountCredits, method, detail, walletAddress })
//     -> Promise<{ id, status, demo, method, amountCredits, walletAddress, raw? }>
//     Records/creates the charge. For a real processor this is where it
//     would build the on-chain / hosted checkout charge (e.g. a Ninjji
//     payment request, a Coinbase Commerce charge, a BTCPay invoice) and
//     return its id + status ('pending' until the webhook confirms).
//   getStatus(chargeId) -> Promise<{ id, status, demo }>
//     For a real processor this polls/reads the charge state; settlement
//     confirmation for production should ALSO arrive via the processor's
//     webhook into a future /api/payment-webhook handler that calls the
//     same store functions the demo provider uses below.
//
// Configuration (env-driven, no code change to switch):
//   PAYMENTS_PROVIDER   'demo' (default). Set to a real provider's name
//                       once its provider file exists in this folder and
//                       is registered in PROVIDERS below.
//   A real provider reads its own keys from env, e.g.:
//     NINJJI_API_KEY / NINJJI_WEBHOOK_SECRET
//     COINBASE_COMMERCE_API_KEY / COINBASE_COMMERCE_WEBHOOK_SECRET
//     BTCPAY_URL / BTCPAY_API_KEY
//   …and must never be required at module load: like lib/store.js, load
//   keys lazily inside createCharge so the app boots without them.
//
// Methods stay OPEN, per product rule — no lock-in to one coin, wallet,
// or processor: ninjji (native, preferred), credits, btc, eth, usdc,
// card, and fiat usd / jpy / lkr (from data/seed.json paymentMethods).
// Crypto methods are: ninjji, btc, eth, usdc. When a user has connected
// a wallet (users.wallet_address) and pays with a crypto method, the
// wallet address is passed through and recorded on the payment.

const { backend } = require('./store');

const CRYPTO_METHODS = ['ninjji', 'btc', 'eth', 'usdc'];

function isCryptoMethod(method) {
  return CRYPTO_METHODS.includes(method);
}

// --- Demo provider: current behavior. Records the charge in the payments
// table marked demo (via the store), moves no real money, and reports the
// charge as instantly 'demo_recorded'. This is the ONLY provider in this
// build; real on-chain payment is intentionally not implemented yet.
const demoProvider = {
  name: 'demo',
  async createCharge({ userId, kind, amountCredits, method, detail, walletAddress }) {
    const recordWallet = isCryptoMethod(method) ? walletAddress || null : null;
    await backend.addPayment({
      userId,
      kind,
      credits: amountCredits,
      method,
      detail: detail || '',
      walletAddress: recordWallet,
    });
    const payments = await backend.listPayments(userId);
    const record = payments[0];
    return {
      id: record ? record.id : null,
      status: 'demo_recorded',
      demo: true,
      method,
      amountCredits,
      walletAddress: recordWallet,
    };
  },
  async getStatus(chargeId) {
    return { id: chargeId, status: 'demo_recorded', demo: true };
  },
};

// Register real providers here when their files land, e.g.:
//   const ninjjiProvider = require('./payments-ninjji');
//   PROVIDERS[ninjjiProvider.name] = ninjjiProvider;
const PROVIDERS = {
  demo: demoProvider,
};

function getProvider() {
  const name = process.env.PAYMENTS_PROVIDER || 'demo';
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown PAYMENTS_PROVIDER "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return provider;
}

module.exports = { getProvider, isCryptoMethod, CRYPTO_METHODS, PROVIDERS };
