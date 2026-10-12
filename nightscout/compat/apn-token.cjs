'use strict';

// Nightscout only uses token-authenticated APNs. Avoid the certificate parser
// and node-forge dependency while preserving its notification/result contract.
const { ApnsClient, Notification: TokenNotification, Errors } = require('apns2');
const fs = require('node:fs');
const errorReasons = new Set(Object.values(Errors));

class Notification {}

class Provider {
  constructor(options) {
    if (!options.token) throw new Error('APNs token credentials required');
    this.client = new ApnsClient({
      team: options.token.teamId,
      keyId: options.token.keyId,
      signingKey: typeof options.token.key === 'string' && !options.token.key.includes('-----BEGIN')
        ? fs.readFileSync(options.token.key) : options.token.key,
      host: options.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com',
      keepAlive: false
    });
  }

  async send(notification, devices) {
    const sent = [], failed = [];
    const timeout = setTimeout(() => { void this.client.destroy(); }, 25000);
    timeout.unref();
    try {
      for (const device of devices) {
        const message = new TokenNotification(device, {
          topic: notification.topic,
          alert: notification.alert,
          contentAvailable: Boolean(notification.contentAvailable),
          expiration: 0,
          aps: { 'interruption-level': notification.interruptionLevel },
          data: notification.payload
        });
        try {
          await this.client.send(message);
          sent.push({ device });
        } catch (error) {
          // Do not propagate keys, device tokens, request payloads or headers.
          failed.push({ response: { reason: errorReasons.has(error.reason) ? error.reason : 'APNs delivery failed' } });
        }
      }
      return { sent, failed };
    } finally {
      clearTimeout(timeout);
      await this.client.close();
    }
  }
}

module.exports = { Provider, Notification };
