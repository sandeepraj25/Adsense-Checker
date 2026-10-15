// Resolves the made-up *-fixture.com names to 127.0.0.1 for this process
// (the address screen sees a public-looking address). Load with
// `import` or `node --import`.
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
const FIXTURE = /(^|\.)[a-z]+-fixture\.com$/i;
const PUBLIC_LOOKING = "93.184.216.34";
const realLookup = dns.lookup;
const realPromiseLookup = dnsPromises.lookup;
dnsPromises.lookup = async (host, options) =>
  FIXTURE.test(host) ? (options?.all ? [{ address: PUBLIC_LOOKING, family: 4 }] : { address: PUBLIC_LOOKING, family: 4 }) : realPromiseLookup(host, options);
dns.lookup = (host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options ?? {};
  if (!FIXTURE.test(host)) return realLookup(host, options, callback);
  if (opts.all) return process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]);
  return process.nextTick(cb, null, "127.0.0.1", 4);
};

// Standard-port fixtures without a privileged port. A scan started through
// the app reads a site on the standard HTTP port (80), and listening on
// port 80 needs special rights on most systems. When FIXTURE_HTTP_PORT is
// set, a connection to a fixture name on port 80 is sent to that local
// port instead. Only *-fixture.com names are affected; the app's own code,
// its address screen and every other connection are untouched.
import net from "node:net";
const realConnect = net.connect;
function fixturePort(args) {
  const target = Number(process.env.FIXTURE_HTTP_PORT);
  const options = args[0];
  if (!Number.isInteger(target) || target <= 0 || !options || typeof options !== "object") return args;
  if (!FIXTURE.test(String(options.host ?? options.servername ?? "")) || Number(options.port) !== 80) return args;
  return [{ ...options, port: target }, ...args.slice(1)];
}
net.connect = net.createConnection = function connect(...args) {
  return realConnect.apply(this, fixturePort(args));
};
