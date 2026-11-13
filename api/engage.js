const { handle } = require('../lib/api');
// Consolidated engagement endpoints (share queue / tips / buddy
// responses) behind rewrites in vercel.json to stay within the Hobby
// plan's 12-function limit.
module.exports = (req, res) => {
  const op = (req.query && req.query.op) || 'share';
  return handle(req, res, op);
};
