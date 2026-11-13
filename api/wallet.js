const { handle } = require('../lib/api');
// /api/wallet-address is rewritten to /api/wallet?op=wallet-address (vercel.json)
// to stay within the Hobby plan's 12-function limit.
module.exports = (req, res) => {
  const op = (req.query && req.query.op) || 'wallet';
  return handle(req, res, op);
};
