// Izzy — matching engine, slice 1.
//
// Izzy is Raahi's central intelligent travel engine. This is its first,
// deliberately small slice inside Raahi NOW: simple, explainable,
// rule-based matching. No AI, no scores we can't explain — just: "in
// the same market, here are open posts from the other side that could
// fit." The UI labels it honestly ("Izzy found a possible match").
//
// Later slices plug in here: Asks, Drops, times, budgets, party sizes,
// and eventually the learned ranking. Keep this module PURE (no store
// access, no I/O) so it can be lifted into the central engine as-is.
//
// matchFor({ marketId, kind, offers, buddies, events }) -> array of
// complementary open items in the same market:
//   kind 'buddy' (a traveler looking for company)
//        -> offers + events in that market (things they could join)
//   kind 'offer' (a local hosting a moment)
//        -> buddy posts in that market (travelers who might join)
//   kind 'event' (a vendor's event)
//        -> buddy posts in that market (travelers who might come)

function inMarket(items, marketId) {
  return (items || []).filter((i) => i && i.marketId === marketId);
}

function matchFor({ marketId, kind, offers = [], buddies = [], events = [] }) {
  if (!marketId) return [];
  if (kind === 'buddy') {
    return [...inMarket(offers, marketId), ...inMarket(events, marketId)];
  }
  if (kind === 'offer' || kind === 'event') {
    return inMarket(buddies, marketId);
  }
  return [];
}

function matchCount(args) {
  return matchFor(args).length;
}

module.exports = { matchFor, matchCount };
