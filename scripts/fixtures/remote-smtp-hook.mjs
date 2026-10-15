// Loaded into a test server (`node --import`) so that the made-up mail host
// below resolves to 127.0.0.1 inside that process only.
//
// The SMTP suite needs a server the app treats as *remote* (anything but
// localhost / 127.0.0.1 / ::1 must offer STARTTLS before the password is
// sent) that still runs on this machine. A spare loopback address such as
// 127.0.0.2 only exists on Linux; macOS configures 127.0.0.1 alone. A name
// under the reserved .test domain works everywhere: real DNS never answers
// for it, and this hook points it at the local sink.

import dns from "node:dns";

export const REMOTE_SMTP_HOST = "mail.remote-smtp.test";

const realLookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  const cb = typeof options === "function" ? options : callback;
  const opts = typeof options === "function" ? {} : options ?? {};
  if (String(host).toLowerCase() !== REMOTE_SMTP_HOST) return realLookup(host, options, callback);
  if (opts.all) return process.nextTick(cb, null, [{ address: "127.0.0.1", family: 4 }]);
  return process.nextTick(cb, null, "127.0.0.1", 4);
};
