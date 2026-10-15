// Points made-up *-fixture.com names at 127.0.0.1, in this process only,
// and makes every other name fail, so tests never touch the internet.
// The address screen (dns/promises) sees a public-looking address, so it
// runs exactly as in production; the connection (dns.lookup) goes local.
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { isIP } from "node:net";

const FIXTURE = /(^|\.)[a-z]+-fixture\.com$/i;
const PUBLIC_LOOKING = "93.184.216.34";

/** Tests are hermetic: every other name fails to resolve, so nothing reaches the internet (pages, scripts, WHOIS). */
function notFound(host) {
  const error = new Error(`getaddrinfo ENOTFOUND ${host}`);
  error.code = "ENOTFOUND";
  error.hostname = host;
  return error;
}

/** Local addresses still resolve normally (servers listen on 127.0.0.1). */
function local(host) {
  return isIP(host) !== 0 || host === "localhost";
}

export function installFixtureDns() {
  const realLookup = dns.lookup;
  const realPromiseLookup = dnsPromises.lookup;
  dnsPromises.lookup = async (host, options) => {
    if (local(host)) return realPromiseLookup(host, options);
    if (!FIXTURE.test(host)) throw notFound(host);
    return options?.all ? [{ address: PUBLIC_LOOKING, family: 4 }] : { address: PUBLIC_LOOKING, family: 4 };
  };
  dns.lookup = (host, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options ?? {};
    if (local(host)) return realLookup(host, options, callback);
    if (!FIXTURE.test(host)) return process.nextTick(cb, notFound(host));
    if (opts.all) return process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]);
    return process.nextTick(cb, null, "127.0.0.1", 4);
  };
}
