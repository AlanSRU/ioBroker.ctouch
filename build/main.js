"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_client = require("./lib/client");
var import_models = require("./lib/models");
var import_protocol = require("./lib/protocol");
var import_wol = require("./lib/wol");
const RESERVED_IDS = ["info"];
const SAME_INPUT_TIMEOUT_MS = 3500;
class Ctouch extends utils.Adapter {
  displays = /* @__PURE__ */ new Map();
  /** ids of disabled displays, whose objects are kept */
  disabledIds = /* @__PURE__ */ new Set();
  pollTimer;
  /** set first thing in onUnload, so a still-running onReady stops before opening connections */
  stopped = false;
  constructor(options = {}) {
    super({
      ...options,
      name: "ctouch"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    this.buildDisplays();
    await this.removeStaleObjects();
    for (const d of this.displays.values()) {
      await this.createObjects(d);
      await this.setState(`${d.id}.info.connection`, { val: false, ack: true });
    }
    for (const id of this.disabledIds) {
      if (await this.getObjectAsync(`${id}.info.connection`)) {
        await this.setState(`${id}.info.connection`, { val: false, ack: true });
      }
    }
    if (this.stopped) {
      return;
    }
    this.subscribeStates("*.control.*");
    if (!this.displays.size) {
      this.log.warn("No displays configured \u2014 open the instance settings and add at least one.");
      return;
    }
    for (const d of this.displays.values()) {
      d.client.start();
    }
    const pollMs = Math.min(3600, Math.max(5, Number(this.config.pollInterval) || 30)) * 1e3;
    this.pollTimer = this.setInterval(() => {
      for (const d of this.displays.values()) {
        if (d.client.connected && d.client.idle) {
          this.queryAll(d);
        }
      }
    }, pollMs);
  }
  /** Turn the configured display table into runtime displays. */
  buildDisplays() {
    var _a;
    const devices = (_a = this.config.devices) != null ? _a : [];
    for (const device of devices) {
      const host = (device.host || "").trim();
      const label = (device.name || "").trim() || host;
      if (!host) {
        this.log.warn(`Ignoring display "${label || "(unnamed)"}": no host configured.`);
        continue;
      }
      const id = this.makeId(label);
      if (device.enabled === false) {
        this.disabledIds.add(id);
        continue;
      }
      const modelId = device.model && import_models.MODELS[device.model] ? device.model : import_models.DEFAULT_MODEL;
      const model = import_models.MODELS[modelId];
      const codec = import_protocol.CODECS[model.protocol];
      const network = device.connection === "network";
      const port = Number(device.port) || (network ? model.networkPort : void 0);
      if (!port) {
        this.log.warn(
          `Ignoring display "${label}": ${network ? `${model.name} has no documented network port` : "no converter port configured"}.`
        );
        continue;
      }
      const displayId = Number(device.displayId);
      const idError = codec.checkId(displayId);
      if (idError) {
        this.log.warn(`Ignoring display "${label}": ${idError} (the Set ID in the display's menu).`);
        continue;
      }
      const mac = device.mac ? (0, import_wol.parseMac)(device.mac) : void 0;
      if (device.mac && !mac) {
        this.log.warn(`Display "${label}": "${device.mac}" is not a MAC address; Wake-on-LAN is disabled.`);
      }
      if (network && !mac) {
        this.log.info(
          `Display "${label}": no MAC address, so it cannot be switched on over the network (Wake-on-LAN).`
        );
      }
      const client = new import_client.DisplayClient({
        host,
        port,
        codec,
        id: displayId,
        timers: {
          setTimeout: (callback, ms) => this.setTimeout(callback, ms),
          clearTimeout: (handle) => this.clearTimeout(handle)
        }
      });
      const display = { id, label, model, codec, network, mac, client };
      this.attach(display);
      this.displays.set(id, display);
      this.log.info(
        `Display "${label}" (${model.name}, Set ID ${displayId}) -> ${this.namespace}.${id} via ${network ? "its network port" : "a serial converter"} ${host}:${port}`
      );
    }
  }
  /**
   * Derive a unique object id from a display name. Lower case, so that names differing only in
   * case do not fork into two object trees.
   *
   * @param label - display name or host
   */
  makeId(label) {
    const base = label.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "display";
    let id = RESERVED_IDS.includes(base) ? `${base}_display` : base;
    for (let suffix = 2; this.displays.has(id) || this.disabledIds.has(id); suffix++) {
      id = `${base}_${suffix}`;
    }
    return id;
  }
  /** Delete device folders of displays that are no longer configured. */
  async removeStaleObjects() {
    for (const obj of await this.getDevicesAsync()) {
      const id = obj._id.substring(this.namespace.length + 1);
      if (!id.includes(".") && !this.displays.has(id) && !this.disabledIds.has(id)) {
        this.log.info(`Removing objects of display "${id}", which is no longer configured.`);
        await this.delObjectAsync(id, { recursive: true });
      }
    }
  }
  async createObjects(d) {
    await this.extendObject(d.id, { type: "device", common: { name: d.label }, native: {} });
    await this.extendObject(`${d.id}.control`, { type: "channel", common: { name: "Control" }, native: {} });
    await this.extendObject(`${d.id}.info`, { type: "channel", common: { name: "Information" }, native: {} });
    const state = async (id, common) => {
      await this.extendObject(`${d.id}.${id}`, {
        type: "state",
        common: { read: true, write: false, ...common },
        native: {}
      });
    };
    await state("control.power", { name: "Power", type: "boolean", role: "switch.power", write: true });
    await state("control.volume", {
      name: "Volume",
      type: "number",
      role: "level.volume",
      min: 0,
      max: 100,
      unit: "%",
      write: true
    });
    await state("control.mute", { name: "Mute", type: "boolean", role: "media.mute", write: true });
    await state("control.input", {
      name: "Input",
      type: "string",
      role: "media.input",
      write: true,
      states: Object.fromEntries(d.model.inputs.map((i) => [(0, import_models.formatInput)(d.model.protocol, i.code), i.name]))
    });
    await state("info.connection", {
      name: "Display answering",
      type: "boolean",
      role: "indicator.connected",
      def: false
    });
    await state("info.lastError", { name: "Why the last command did not complete", type: "string", role: "text" });
    await state("info.model", { name: "Model", type: "string", role: "info.name" });
    await this.setState(`${d.id}.info.model`, { val: d.model.name, ack: true });
  }
  /**
   * Wire a display's client events into its states.
   *
   * @param d - the display
   */
  attach(d) {
    const c = d.client;
    c.on("link", (up) => {
      this.log.debug(`[${d.label}] ${up ? "connected to" : "lost"} ${d.network ? "display" : "converter"}`);
      if (up) {
        this.queryAll(d);
      }
    });
    c.on("answering", (answering) => void this.onAnswering(d, answering));
    c.on("value", (field, value) => void this.onValue(d, field, value));
    c.on("refused", (field, reason, wasQuery) => {
      if (wasQuery) {
        this.log.debug(`[${d.label}] does not answer a ${field} query: ${reason}`);
        return;
      }
      void this.fail(d, `${field}: display refused it (${reason})`, field);
    });
    c.on("noReply", (field) => void this.fail(d, `${field}: no reply from the display`, field));
    c.on("notSent", (field, reason) => void this.fail(d, `${field}: not sent, ${reason}`));
    c.on("discarded", (bytes) => this.log.debug(`[${d.label}] ignored ${bytes.toString("hex")}`));
  }
  queryAll(d) {
    import_protocol.FIELDS.forEach((field) => d.client.query(field));
  }
  async onAnswering(d, answering) {
    this.log.info(`[${d.label}] ${answering ? "answering" : "not answering"}`);
    await this.setState(`${d.id}.info.connection`, { val: answering, ack: true });
    if (!answering && d.network) {
      await this.setState(`${d.id}.control.power`, { val: false, ack: true });
    }
    const any = [...this.displays.values()].some((x) => x.client.answering);
    await this.setState("info.connection", { val: any, ack: true });
  }
  async onValue(d, field, value) {
    let val;
    switch (field) {
      case "power":
        val = d.codec.isPowerOn(value);
        break;
      case "mute":
        val = value === 1;
        break;
      case "volume":
        val = value;
        break;
      case "input":
        d.confirmedInput = value;
        val = (0, import_models.formatInput)(d.model.protocol, value);
        break;
    }
    await this.setState(`${d.id}.control.${field}`, { val, ack: true });
  }
  /**
   * Record why a request did not complete, and read the real value back so the tree does not
   * keep showing the value that was asked for.
   *
   * @param d - the display
   * @param message - what went wrong
   * @param field - the field to read back, if any
   */
  async fail(d, message, field) {
    this.log.warn(`[${d.label}] ${message}`);
    await this.setState(`${d.id}.info.lastError`, { val: message, ack: true });
    if (field) {
      d.client.query(field);
    }
  }
  /**
   * Is called if a subscribed state changes.
   *
   * @param id - State ID
   * @param state - State object
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const rel = id.substring(`${this.namespace}.`.length);
    const separator = rel.indexOf(".");
    const d = separator > 0 ? this.displays.get(rel.substring(0, separator)) : void 0;
    if (!d) {
      return;
    }
    const key = rel.substring(separator + 1);
    await this.setState(`${d.id}.info.lastError`, { val: "", ack: true });
    switch (key) {
      case "control.power": {
        const on = state.val === true || state.val === "true" || state.val === 1;
        if (on && d.network && !d.client.answering) {
          await this.wakeOnLan(d);
          break;
        }
        d.client.set("power", d.codec.powerValue(on));
        break;
      }
      case "control.volume": {
        const level = Math.round(Number(state.val));
        if (!Number.isFinite(level)) {
          await this.fail(d, `volume: "${String(state.val)}" is not a number`, "volume");
          return;
        }
        d.client.set("volume", Math.max(0, Math.min(100, level)));
        break;
      }
      case "control.mute":
        d.client.set("mute", state.val === true || state.val === "true" || state.val === 1 ? 1 : 0);
        break;
      case "control.input": {
        const code = (0, import_models.parseInput)(d.model.protocol, state.val);
        if (code === void 0 || !d.model.inputs.some((i) => i.code === code)) {
          const valid = d.model.inputs.map((i) => `${(0, import_models.formatInput)(d.model.protocol, i.code)} ${i.name}`);
          await this.fail(
            d,
            `input: "${String(state.val)}" is not a ${d.model.name} input (${valid.join(", ")})`,
            "input"
          );
          return;
        }
        d.client.set("input", code, d.confirmedInput === code ? SAME_INPUT_TIMEOUT_MS : void 0);
        break;
      }
      default:
        this.log.warn(`Unhandled writable state: ${id}`);
    }
  }
  async wakeOnLan(d) {
    if (!d.mac) {
      this.log.warn(`[${d.label}] cannot switch on over the network without a MAC address (Wake-on-LAN).`);
      return;
    }
    try {
      await (0, import_wol.wake)(d.mac);
      this.log.debug(`[${d.label}] Wake-on-LAN sent`);
    } catch (error) {
      this.log.warn(`[${d.label}] Wake-on-LAN failed: ${error.message}`);
    }
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    this.stopped = true;
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
      }
      for (const d of this.displays.values()) {
        d.client.stop();
      }
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Ctouch(options);
} else {
  (() => new Ctouch())();
}
//# sourceMappingURL=main.js.map
