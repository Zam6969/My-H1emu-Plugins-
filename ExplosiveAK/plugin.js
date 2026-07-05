// Export the class directly (not the module namespace) so it constructs
// correctly on every Node version.
module.exports = require("./out/plugin").default;
