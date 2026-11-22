#!/usr/bin/env node
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
// Thin custom host: Next owns HTTP, this host owns exactly one upgrade path.
const http = require("node:http");
const path = require("node:path");
const next = require("next");

async function main() {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const at = args.indexOf(flag); return at < 0 ? fallback : args[at + 1]; };
  const dev = args.includes("--dev");
  const port = Number(value("-p", "30141"));
  const hostname = value("-H", "127.0.0.1");
  const dir = path.join(__dirname, "..");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid server port");
  process.env.PI_WEB_HOSTNAME = hostname;
  if (dev) process.env.NODE_ENV = "development";
  else process.env.NODE_ENV = "production";
  // Next installs its HMR/upgrade listener on the documented httpServer option.
  // Give it a dispatcher so only NON-sync upgrades reach that listener. Never
  // attach two consumers to the same socket or mutate Next's private internals.
  const upgrades = http.createServer();
  const app = next({ dev, dir, hostname, port, httpServer: upgrades });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/api/sync/socket") {
      const handler = globalThis[Symbol.for("pi-web:sync-upgrade")];
      if (typeof handler === "function") handler(req, socket, head);
      else socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    } else if (!upgrades.emit("upgrade", req, socket, head)) socket.destroy();
  });
  server.on("error", () => { console.error("Pi Web server failed to listen"); process.exitCode = 1; });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    const timer = setTimeout(() => process.exit(1), 10_000); timer.unref();
    server.close(() => { Promise.resolve(app.close()).finally(() => process.exit(0)); });
    server.closeIdleConnections();
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, hostname, resolve); });
  // Ensure Next installs its dispatcher and loads instrumentation before WSS is
  // advertised ready. This is a loopback request with no credentials or data.
  const address = server.address();
  await new Promise((resolve) => {
    const req = http.get({ host: hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "::1" : hostname, port: address.port, path: "/api/web-auth", timeout: 30_000 }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve); req.on("timeout", () => req.destroy());
  });
  console.log(`Ready - Pi Web on ${hostname}:${address.port}`);
}
main().catch(() => { console.error("Pi Web server startup failed"); process.exitCode = 1; });
