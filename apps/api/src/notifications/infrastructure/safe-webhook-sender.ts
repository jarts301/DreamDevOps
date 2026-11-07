import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { RefusedWebhookError, type WebhookSender } from '../application/ports.ts';

export interface SafeWebhookOptions {
  /** Allows internal and local addresses, for local testing only. */
  readonly allowPrivateNetworks: boolean;
  readonly timeoutMs?: number;
}

/** Addresses a webhook must never reach, such as this machine, the internal network or cloud metadata. */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  // An IPv6 address can wrap an IPv4 one, such as ::ffff:127.0.0.1.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) {
    return BLOCKED.check(mapped, 'ipv4');
  }
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Posts to webhooks without letting an address reach internal services. The check runs
 * on the address actually connected to, so a name can't resolve differently between the
 * check and the request. Redirects aren't followed, and responses aren't read.
 */
export class SafeWebhookSender implements WebhookSender {
  readonly #options: SafeWebhookOptions;

  constructor(options: SafeWebhookOptions) {
    this.#options = options;
  }

  async post(url: string, body: object): Promise<void> {
    const target = new URL(url);
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) !== 0 && !this.#options.allowPrivateNetworks && isBlockedAddress(hostname)) {
      throw new RefusedWebhookError('The webhook address points to an internal network, which is not allowed.');
    }
    const payload = JSON.stringify(body);
    const client = target.protocol === 'https:' ? https : http;

    await new Promise<void>((resolve, reject) => {
      const request = client.request(
        target,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: this.#options.timeoutMs ?? 10_000,
          lookup: this.#lookup,
        },
        (response) => {
          response.resume();
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
          } else {
            reject(new Error(`The webhook answered with status ${status}.`));
          }
        },
      );
      request.on('timeout', () => request.destroy(new Error('The webhook did not answer in time.')));
      request.on('error', (error) =>
        reject(error instanceof RefusedWebhookError ? error : new Error('The webhook could not be reached.')),
      );
      request.end(payload);
    });
  }

  readonly #lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (!this.#options.allowPrivateNetworks && addresses.some((entry) => isBlockedAddress(entry.address))) {
        callback(
          new RefusedWebhookError('The webhook address points to an internal network, which is not allowed.'),
          '',
          0,
        );
        return;
      }
      if (options.all) {
        (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}
