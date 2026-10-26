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
var wol_exports = {};
__export(wol_exports, {
  magicPacket: () => magicPacket,
  parseMac: () => parseMac,
  wake: () => wake
});
module.exports = __toCommonJS(wol_exports);
var import_node_dgram = require("node:dgram");
function parseMac(mac) {
  const hex = mac.trim().replace(/[:-]/g, "");
  return /^[0-9a-f]{12}$/i.test(hex) ? Buffer.from(hex, "hex") : void 0;
}
function magicPacket(mac) {
  return Buffer.concat([Buffer.alloc(6, 255), ...Array(16).fill(mac)]);
}
async function wake(mac, address = "255.255.255.255") {
  const socket = (0, import_node_dgram.createSocket)("udp4");
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(magicPacket(mac), 9, address, (error) => error ? reject(error) : resolve());
      });
    });
  } finally {
    socket.close();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  magicPacket,
  parseMac,
  wake
});
//# sourceMappingURL=wol.js.map
