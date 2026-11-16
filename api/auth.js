const { handle } = require('../lib/api');
// Consolidated auth endpoints (signup/login/logout/me/me-socials) behind
// rewrites in vercel.json to stay within the Hobby plan's 12-function limit.
module.exports = (req, res) => {
  const op = (req.query && req.query.op) || 'me';
  return handle(req, res, op);
};
