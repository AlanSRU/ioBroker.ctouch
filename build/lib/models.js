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
var models_exports = {};
__export(models_exports, {
  DEFAULT_MODEL: () => DEFAULT_MODEL,
  MODELS: () => MODELS,
  formatInput: () => formatInput,
  parseInput: () => parseInput
});
module.exports = __toCommonJS(models_exports);
const MODELS = {
  laserNova: {
    name: "CTOUCH Laser Nova",
    protocol: "a9",
    baud: 9600,
    networkPort: 5e3,
    document: "RS-232 protocol for CTOUCH Laser Nova + Laser Sky V4.02",
    inputs: [
      { code: 5, name: "HDMI 1" },
      { code: 6, name: "HDMI 2" },
      { code: 8, name: "HDMI 3" },
      { code: 7, name: "DisplayPort" },
      { code: 20, name: "VGA" },
      { code: 9, name: "Inside PC" },
      { code: 13, name: "Android" },
      { code: 12, name: "Home" }
    ]
  },
  laserSky: {
    name: "CTOUCH Laser Sky",
    protocol: "a9",
    baud: 9600,
    networkPort: 5e3,
    document: "RS-232 protocol for CTOUCH Laser Nova + Laser Sky V4.02",
    inputs: [
      { code: 5, name: "HDMI 1" },
      { code: 6, name: "HDMI 2" },
      { code: 8, name: "HDMI 3" },
      // 0x0D is HDMI 4 on the Sky (with the Wi-Fi module), Android on the Nova
      { code: 13, name: "HDMI 4" },
      { code: 7, name: "DisplayPort" },
      { code: 20, name: "VGA" },
      { code: 9, name: "Inside PC" },
      { code: 12, name: "Home" }
    ]
  },
  rivaR2: {
    name: "CTOUCH Riva R2",
    protocol: "a9",
    baud: 9600,
    networkPort: 5e3,
    document: "CTOUCH Riva R2 RS232 protocol V230414",
    inputs: [
      { code: 5, name: "HDMI 1" },
      { code: 6, name: "HDMI 2" },
      { code: 8, name: "HDMI 3" },
      { code: 7, name: "DisplayPort" },
      // the document gives 0x0E for both USB-C ports
      { code: 14, name: "USB-C" },
      { code: 20, name: "VGA" },
      { code: 1, name: "AV" },
      { code: 9, name: "Inside PC" },
      { code: 12, name: "Android" }
    ]
  },
  neo: {
    name: "CTOUCH Neo",
    protocol: "a9",
    baud: 115200,
    document: "Neo RS232 specification v1.3",
    inputs: [
      { code: 5, name: "HDMI 1" },
      { code: 6, name: "HDMI 2" },
      { code: 8, name: "HDMI 3" },
      { code: 7, name: "DisplayPort" },
      { code: 14, name: "USB-C" },
      { code: 9, name: "OPS" },
      { code: 12, name: "Android" }
    ]
  },
  cactus: {
    name: "i3-CONNECT Cactus",
    protocol: "i3",
    baud: 9600,
    networkPort: 4664,
    document: "i3CONNECT RS232 Specification Cactus v1.2",
    inputs: [
      { code: 1, name: "HDMI 1" },
      { code: 2, name: "HDMI 2" },
      { code: 21, name: "HDMI 3" },
      { code: 22, name: "HDMI 4" },
      { code: 101, name: "Android" }
    ]
  },
  veneer2: {
    name: "i3-CONNECT Veneer 2",
    protocol: "i3",
    baud: 9600,
    networkPort: 4664,
    document: "i3CONNECT RS232 Specification Veneer 2 v1.0",
    inputs: [
      { code: 1, name: "HDMI 1" },
      { code: 2, name: "HDMI 2" },
      { code: 21, name: "HDMI 3" },
      { code: 7, name: "DisplayPort" },
      { code: 104, name: "USB-C 1" },
      { code: 105, name: "USB-C 2" },
      { code: 0, name: "VGA" },
      { code: 103, name: "Slot-in PC" },
      { code: 101, name: "Android" }
    ]
  }
};
const DEFAULT_MODEL = "laserNova";
function formatInput(protocol, code) {
  return protocol === "a9" ? code.toString(16).toUpperCase().padStart(2, "0") : String(code).padStart(3, "0");
}
function parseInput(protocol, value) {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  if (protocol === "a9") {
    return /^[0-9a-f]{1,2}$/i.test(text) ? parseInt(text, 16) : void 0;
  }
  return /^\d{1,3}$/.test(text) ? Number(text) : void 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_MODEL,
  MODELS,
  formatInput,
  parseInput
});
//# sourceMappingURL=models.js.map
