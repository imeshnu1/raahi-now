// Connection readiness for Raahi NOW.
//
// Raahi NOW is its OWN product surface. It does NOT merge with Raahi's
// main apps (the Raahi web app for travelers, the Raahi Traveler app,
// the Raahi Expert app) and it does not share their login or database
// today. This file is the single place that records WHERE those apps
// live, so linking out — and one day connecting accounts — is a
// configuration change, not a hunt through the codebase.
//
// See INTEGRATION.md at the repo root for the full connection plan.

const LINKS = {
  // Raahi's main marketing / company home.
  raahiWeb: 'https://raahi.io',
  // Raahi web app for travelers.
  travelerWebApp: 'https://app.raahi.io',
  // Raahi Expert app store listings. null until Imesh provides the
  // real store URLs — UI falls back to raahiWeb while these are null.
  expertApp: { ios: null, android: null },
  // Deep-link scheme reserved for Raahi NOW, so other Raahi apps can
  // hand a traveler straight into a Drop / Offer / Event later.
  nowDeepLinkScheme: 'raahi-now://',
};

const CONNECTION = {
  // NOW runs its own accounts today (lib/auth.js, local scrypt +
  // cookie sessions). Nothing is shared with the main apps yet.
  identityProvider: 'local',
  // The intended future identity provider for a unified Raahi login.
  // When that day comes, the Firebase UID lands in users.external_id
  // (already migrated in lib/store.js) and auth swaps behind the same
  // session interface — no data move, just a mapping.
  futureIdentityProvider: 'firebase',
  note: 'NOW stays a separate product. Connection points are: users.external_id for identity mapping, the booking payload shape (see INTEGRATION.md), footer link-outs to the other apps, the outbox table for the social engine, and lib/engine.js for Izzy matching.',
};

module.exports = { LINKS, CONNECTION };
