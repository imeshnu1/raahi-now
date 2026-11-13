const { handle } = require('../lib/api');
// Consolidated two-sided posting endpoints (offers / buddies / events)
// behind rewrites in vercel.json to stay within the Hobby plan's
// 12-function limit.
module.exports = (req, res) => {
  const op = (req.query && req.query.op) || 'offers';
  return handle(req, res, op);
};
