'use strict';

// Provider selector. Chooses the WhatsApp send back-end by env.WA_PROVIDER.
// Defaults to "personal" (whatsapp-web.js). "business" uses the Cloud API.

const createPersonalProvider = require('./personal');
const createBusinessProvider = require('./business');

/**
 * Select and construct a provider instance from the environment.
 * @param {object} env - process.env (or a compatible object).
 * @returns {object} a provider implementing the shared contract.
 */
function getProvider(env = process.env) {
  const which = (env.WA_PROVIDER || 'personal').trim().toLowerCase();
  switch (which) {
    case 'business':
      return createBusinessProvider(env);
    case 'personal':
    default:
      return createPersonalProvider(env);
  }
}

module.exports = { getProvider };
