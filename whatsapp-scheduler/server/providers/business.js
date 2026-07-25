'use strict';

// Business provider — WhatsApp Business Cloud API (official, token-based).
// Uses global fetch (Node >= 18). No extra dependencies.

/**
 * @param {object} env - process.env
 * @returns {object} provider instance implementing the shared contract.
 */
function createBusinessProvider(env = process.env) {
  const phoneId = env.WA_PHONE_NUMBER_ID;
  const token = env.WA_ACCESS_TOKEN;
  const version = env.WA_API_VERSION || 'v21.0';

  return {
    name: 'business',

    async init() {
      // Nothing to initialize: the Cloud API is stateless request/response.
    },

    getStatus() {
      return {
        provider: 'business',
        // "connected" means we have the credentials needed to send.
        connected: Boolean(phoneId && token),
        qr: null, // Cloud API never uses a QR
        me: phoneId || null,
      };
    },

    async sendMessage(to, text) {
      if (!phoneId || !token) {
        throw new Error(
          'business provider missing WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN'
        );
      }
      const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text, preview_url: false },
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch (_e) {
          detail = '<unreadable response body>';
        }
        throw new Error(
          `WhatsApp Cloud API send failed: ${res.status} ${res.statusText} ${detail}`
        );
      }
    },

    onInboundCommand(handler) {
      // No-op for v1. Inbound `/schedule` commands over the Cloud API require a
      // publicly reachable Meta webhook receiver (verify token + message
      // handling), which is out of scope here. The handler is intentionally not
      // stored/invoked; wire a webhook to enable inbound in a future version.
      void handler;
    },
  };
}

module.exports = createBusinessProvider;
