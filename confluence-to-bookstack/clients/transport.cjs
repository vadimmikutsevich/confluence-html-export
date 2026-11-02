function configureTransport() {
  // DNS: verbatim = system order. Use for VPN/internal hosts (book.gambchamp.com).
  // ipv4first can break resolution for internal hosts.
  try {
    const dns = require("node:dns");
    if (typeof dns.setDefaultResultOrder === "function") {
      dns.setDefaultResultOrder("verbatim");
    }
  } catch {
    // ignore
  }
  
  // Undici: family 0 = auto (IPv4+IPv6). For internal hosts via VPN.
  try {
    const { Agent, setGlobalDispatcher } = require("undici");
    setGlobalDispatcher(
      new Agent({
        connect: { family: 0 },
        connectTimeout: 30_000,
        headersTimeout: 30_000,
        bodyTimeout: 120_000,
      }),
    );
  } catch {
    // ignore
  }
}

module.exports = { configureTransport };
