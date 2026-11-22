import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { SYNC_WIRE_LIMIT } from "./sync-http";

/** Ordered, encrypted frames bound to one ephemeral connection and direction. */
export class SyncChannel {
  private sent = 0;
  private received = 0;
  private key: Buffer;
  constructor(private ws: WebSocket, secret: string, private binding: string, private outbound: "client" | "server") {
    this.key = Buffer.from(secret, "base64url");
    if (this.key.length !== 32) throw new Error("Invalid sync exchange key");
  }
  private aad(direction: string, sequence: number): Buffer { return Buffer.from(`pi-sync:wss:v1:${this.binding}:${direction}:${sequence}`); }
  send(value: unknown): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount > 1024 * 1024) throw new Error("Synchronization connection is backpressured");
    const sequence = ++this.sent;
    if (!Number.isSafeInteger(sequence)) throw new Error("Synchronization sequence exhausted");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(this.outbound, sequence));
    const plaintext = Buffer.from(JSON.stringify(value));
    if (plaintext.length > 25 * 1024 * 1024) throw new Error("Synchronization message exceeds size limit");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const data = JSON.stringify({ sequence, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") });
    if (Buffer.byteLength(data) > SYNC_WIRE_LIMIT) throw new Error("Synchronization message exceeds size limit");
    return new Promise((resolve, reject) => this.ws.send(data, (error) => error ? reject(new Error("Synchronization send failed")) : resolve()));
  }
  receive(data: Buffer): unknown {
    if (data.length > SYNC_WIRE_LIMIT) throw new Error("Synchronization message exceeds size limit");
    try {
      const value = JSON.parse(data.toString());
      if (value.sequence !== this.received + 1 || typeof value.iv !== "string" || value.iv.length !== 16
        || typeof value.tag !== "string" || value.tag.length !== 22 || typeof value.ciphertext !== "string") throw new Error();
      const iv = Buffer.from(value.iv, "base64url"), tag = Buffer.from(value.tag, "base64url");
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(this.aad(this.outbound === "client" ? "server" : "client", value.sequence));
      decipher.setAuthTag(tag);
      const bytes = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]);
      const parsed: unknown = JSON.parse(bytes.toString());
      this.received = value.sequence;
      return parsed;
    } catch { throw new Error("Invalid encrypted synchronization frame"); }
  }
}
