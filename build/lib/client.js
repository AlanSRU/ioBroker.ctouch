"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var client_exports = {};
__export(client_exports, {
  DisplayClient: () => DisplayClient
});
module.exports = __toCommonJS(client_exports);
var import_node_events = require("node:events");
var import_node_net = require("node:net");
const REPLY_TIMEOUT_MS = 500;
const RECONNECT_MS = 1e4;
const OFFLINE_AFTER_MISSED = 8;
class DisplayClient extends import_node_events.EventEmitter {
  /** @param options - how to reach the display */
  constructor(options) {
    var _a;
    super();
    this.options = options;
    this.timers = (_a = options.timers) != null ? _a : {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle)
    };
  }
  socket;
  linkUp = false;
  isAnswering = false;
  stopped = true;
  reconnectTimer;
  rx = Buffer.alloc(0);
  queue = [];
  inFlight;
  missedQueries = 0;
  timers;
  /** Whether the display is answering. */
  get answering() {
    return this.isAnswering;
  }
  /** Whether the TCP link is up. */
  get connected() {
    return this.linkUp;
  }
  /** Connect, and keep reconnecting until stopped. */
  start() {
    this.stopped = false;
    this.connect();
  }
  /** Disconnect and drop everything pending. */
  stop() {
    var _a;
    this.stopped = true;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
    this.clearPending();
    (_a = this.socket) == null ? void 0 : _a.destroy();
    this.socket = void 0;
  }
  /**
   * Set a value. A newer set of the same field replaces one still waiting (a dragged slider);
   * key presses are all sent (three presses of Down move three places).
   *
   * @param field - what to set
   * @param value - the device value
   * @param timeoutMs - reply timeout, longer when re-selecting the current input
   */
  set(field, value, timeoutMs = ((_a) => (_a = this.options.replyTimeoutMs) != null ? _a : REPLY_TIMEOUT_MS)()) {
    const waiting = field === "key" ? -1 : this.queue.findIndex((r) => r.field === field && r.value !== void 0);
    if (waiting >= 0) {
      this.queue.splice(waiting, 1);
    }
    this.enqueue({ field, value, timeoutMs, retried: false });
  }
  /**
   * Ask for a field's current value. Skipped when already waiting.
   *
   * @param field - what to read
   */
  query(field) {
    var _a;
    if (this.queue.some((r) => r.field === field && r.value === void 0)) {
      return;
    }
    this.enqueue({ field, timeoutMs: (_a = this.options.replyTimeoutMs) != null ? _a : REPLY_TIMEOUT_MS, retried: false });
  }
  /** Whether nothing is queued or waiting for a reply. */
  get idle() {
    return !this.inFlight && !this.queue.length;
  }
  // ── connection ────────────────────────────────────────────────────────────
  connect() {
    if (this.stopped) {
      return;
    }
    this.rx = Buffer.alloc(0);
    const socket = new import_node_net.Socket();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 3e4);
    socket.on("connect", () => {
      this.linkUp = true;
      this.emit("link", true);
      this.sendNext();
    });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => void 0);
    socket.on("close", () => {
      var _a;
      if (this.socket !== socket) {
        return;
      }
      this.socket = void 0;
      const wasUp = this.linkUp;
      this.linkUp = false;
      if (wasUp) {
        this.emit("link", false);
      }
      this.setAnswering(false);
      this.failAll("connection lost");
      if (!this.stopped) {
        this.reconnectTimer = this.timers.setTimeout(() => {
          this.reconnectTimer = void 0;
          this.connect();
        }, (_a = this.options.reconnectMs) != null ? _a : RECONNECT_MS);
      }
    });
    socket.connect(this.options.port, this.options.host);
  }
  setAnswering(answering) {
    if (this.isAnswering !== answering) {
      this.isAnswering = answering;
      this.emit("answering", answering);
    }
  }
  // ── replies ───────────────────────────────────────────────────────────────
  onData(chunk) {
    const { replies, rest, discarded } = this.options.codec.decode(Buffer.concat([this.rx, chunk]));
    this.rx = rest;
    discarded.forEach((bytes) => this.emit("discarded", bytes));
    replies.forEach((reply) => this.onReply(reply));
  }
  onReply(reply) {
    const request = this.inFlight;
    if (!request || "field" in reply && reply.field && reply.field !== request.field) {
      return;
    }
    this.timers.clearTimeout(request.timer);
    this.inFlight = void 0;
    this.missedQueries = 0;
    this.setAnswering(true);
    if (reply.kind === "value") {
      this.emit("value", reply.field, reply.value);
    } else if (reply.kind === "ack") {
      if (request.value !== void 0) {
        this.emit("value", request.field, request.value);
      }
    } else {
      this.emit("refused", request.field, reply.reason, request.value === void 0);
    }
    this.sendNext();
  }
  // ── sending ───────────────────────────────────────────────────────────────
  enqueue(request) {
    this.queue.push(request);
    this.sendNext();
  }
  sendNext() {
    if (this.inFlight || !this.queue.length) {
      return;
    }
    if (!this.linkUp || !this.socket) {
      this.failAll("not connected");
      return;
    }
    this.transmit(this.queue.shift());
  }
  transmit(request) {
    const { codec, id } = this.options;
    this.inFlight = request;
    this.socket.write(
      request.value === void 0 ? codec.encodeQuery(request.field, id) : codec.encodeSet(request.field, request.value, id)
    );
    request.timer = this.timers.setTimeout(() => this.onTimeout(request), request.timeoutMs);
  }
  onTimeout(request) {
    var _a;
    if (this.inFlight !== request) {
      return;
    }
    if (!request.retried && this.socket) {
      request.retried = true;
      this.transmit(request);
      return;
    }
    this.inFlight = void 0;
    if (request.value === void 0) {
      this.missedQueries++;
      if (this.missedQueries >= ((_a = this.options.offlineAfterMissedQueries) != null ? _a : OFFLINE_AFTER_MISSED)) {
        this.setAnswering(false);
      }
    } else {
      this.emit("noReply", request.field);
    }
    this.sendNext();
  }
  /**
   * Drop everything pending. Queries are dropped quietly; sets are reported.
   *
   * @param reason - why, for the notSent event
   */
  failAll(reason) {
    const dropped = this.clearPending();
    dropped.filter((r) => r.value !== void 0).forEach((r) => this.emit("notSent", r.field, reason));
  }
  clearPending() {
    const dropped = [...this.inFlight ? [this.inFlight] : [], ...this.queue.splice(0)];
    if (this.inFlight) {
      this.timers.clearTimeout(this.inFlight.timer);
      this.inFlight = void 0;
    }
    return dropped;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DisplayClient
});
//# sourceMappingURL=client.js.map
