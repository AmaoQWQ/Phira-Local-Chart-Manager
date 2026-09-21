const fs = require("node:fs");
const path = require("node:path");
const selfsigned = require("selfsigned");

const certDir = path.resolve(process.cwd(), "certs");
const certPath = path.join(certDir, "server.crt");
const keyPath = path.join(certDir, "server.key");

fs.mkdirSync(certDir, { recursive: true });

const attributes = [{ name: "commonName", value: "phira.5wyxi.com" }];
const extensions = [
  { name: "basicConstraints", cA: false },
  { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  { name: "extKeyUsage", serverAuth: true },
  {
    name: "subjectAltName",
    altNames: [
      { type: 2, value: "phira.5wyxi.com" },
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
    ],
  },
];

const result = selfsigned.generate(attributes, {
  keySize: 2048,
  days: 3650,
  algorithm: "sha256",
  extensions,
});

fs.writeFileSync(certPath, result.cert, { mode: 0o644 });
fs.writeFileSync(keyPath, result.private, { mode: 0o600 });

console.log(`Generated certificate: ${certPath}`);
console.log(`Generated private key: ${keyPath}`);
console.log("Hosts: phira.5wyxi.com, localhost, 127.0.0.1");
console.log("This self-signed certificate is only for local testing or explicitly enabled Phira unsafe mode.");
