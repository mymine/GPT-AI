// Vercel Serverless Function entrypoint.
//
// Vercel's zero-config detects files inside /api as functions. This wrapper
// simply re-exports the Express app defined in the project root, so all routes
// (/ , /chat/vN, /v1/*) are served by a single function. `index.js` only calls
// app.listen() when it is the main module, which never happens here — so no
// port is ever bound, exactly what serverless needs.
module.exports = require('../index.js');
