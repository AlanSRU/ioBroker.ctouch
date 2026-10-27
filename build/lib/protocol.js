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
var protocol_exports = {};
__export(protocol_exports, {
  CODECS: () => CODECS,
  a9: () => a9,
  i3: () => i3
});
module.exports = __toCommonJS(protocol_exports);
const A9_START = 169;
const A9_END = 138;
const A9_QUERY = 170;
const A9_ACK = 65;
const A9_NAK = 78;
const A9_CMD = {
  power: 17,
  backlight: 18,
  volume: 19,
  mute: 20,
  input: 21,
  key: 22
};
const A9_FIELD = new Map(Object.entries(A9_CMD).map(([field, cmd]) => [cmd, field]));
function errorText(code) {
  return code === 1 ? "invalid command" : code === 2 ? "invalid data" : `error 0x${hex2(code)}`;
}
function hex2(n) {
  return n.toString(16).toUpperCase().padStart(2, "0");
}
const a9 = {
  name: "a9",
  powerValue: (on) => on ? 1 : 0,
  isPowerOn: (value) => value === 1,
  // the backlight has its own query
  backlightFromPower: () => void 0,
  polled: ["power", "volume", "mute", "input", "backlight"],
  encodeSet: (field, value, id) => Buffer.from([A9_START, A9_CMD[field], id, value, A9_END]),
  encodeQuery: (field, id) => Buffer.from([A9_START, A9_CMD[field], id, A9_QUERY, A9_END]),
  checkId: (id) => !Number.isInteger(id) || id < 1 || id > 255 ? "Set ID must be 1-255" : id === A9_START || id === A9_END ? "Set ID 138 (0x8A) and 168 (0xA9) are reserved by the protocol" : void 0,
  decode(buffer) {
    const replies = [];
    const discarded = [];
    let buf = buffer;
    for (; ; ) {
      const start = buf.indexOf(A9_START);
      if (start < 0) {
        if (buf.length) {
          discarded.push(buf);
        }
        return { replies, rest: Buffer.alloc(0), discarded };
      }
      if (start > 0) {
        discarded.push(buf.subarray(0, start));
        buf = buf.subarray(start);
      }
      if (buf.length < 6) {
        return { replies, rest: buf, discarded };
      }
      const frame = buf.subarray(0, 6);
      if (frame[5] !== A9_END || frame[1] !== A9_ACK && frame[1] !== A9_NAK) {
        discarded.push(buf.subarray(0, 1));
        buf = buf.subarray(1);
        continue;
      }
      buf = buf.subarray(6);
      const field = A9_FIELD.get(frame[3]);
      if (frame[1] === A9_NAK) {
        replies.push({ kind: "nak", field, reason: errorText(frame[4]) });
      } else if (field) {
        replies.push({ kind: "value", field, value: frame[4] });
      }
    }
  }
};
const I3_START = 58;
const I3_REPLY_START = 52;
const I3_END = 13;
const I3_CMD = {
  power: 48,
  volume: 56,
  mute: 57,
  input: 58,
  backlight: 48,
  key: 65
};
const I3_FIELD = new Map(
  Object.entries(I3_CMD).filter(([field]) => field !== "backlight").map(([field, cmd]) => [cmd, field])
);
const I3_POWER_OFF = 2;
const I3_POWER_ON = 3;
function idDigits(id) {
  return Buffer.from(String(id).padStart(2, "0"), "ascii");
}
function threeDigits(value) {
  return Buffer.from(String(value).padStart(3, "0"), "ascii");
}
const i3 = {
  name: "i3",
  powerValue: (on) => on ? I3_POWER_ON : I3_POWER_OFF,
  // A dark backlight (000) is still a display that is on.
  isPowerOn: (value) => value === 0 || value === 1 || value === I3_POWER_ON,
  backlightFromPower: (value) => value === 0 ? false : value === 1 ? true : void 0,
  polled: ["power", "volume", "mute", "input"],
  encodeSet: (field, value, id) => Buffer.concat([
    Buffer.from([I3_START]),
    idDigits(id),
    Buffer.from([83, I3_CMD[field]]),
    threeDigits(value),
    Buffer.from([I3_END])
  ]),
  encodeQuery: (field, id) => Buffer.concat([
    Buffer.from([I3_START]),
    idDigits(id),
    Buffer.from([71, I3_CMD[field]]),
    threeDigits(0),
    Buffer.from([I3_END])
  ]),
  checkId: (id) => !Number.isInteger(id) || id < 1 || id > 99 ? "Set ID must be 1-99" : void 0,
  decode(buffer) {
    const replies = [];
    const discarded = [];
    let buf = buffer;
    for (; ; ) {
      const end = buf.indexOf(I3_END);
      if (end < 0) {
        if (buf.length > 64) {
          discarded.push(buf);
          return { replies, rest: Buffer.alloc(0), discarded };
        }
        return { replies, rest: buf, discarded };
      }
      const line = buf.subarray(0, end);
      buf = buf.subarray(end + 1);
      const reply = parseI3Line(line);
      if (reply) {
        replies.push(reply);
      } else if (line.length) {
        discarded.push(line);
      }
    }
  }
};
function parseI3Line(line) {
  if (line.length === 4 && line[0] === I3_REPLY_START) {
    if (line[3] === 43) {
      return { kind: "ack" };
    }
    if (line[3] === 45) {
      return { kind: "nak", reason: "refused" };
    }
  }
  if (line.length === 8 && line[0] === I3_START && line[3] === 114) {
    const field = I3_FIELD.get(line[4]);
    const digits = line.subarray(5, 8).toString("ascii");
    if (field && /^\d{3}$/.test(digits)) {
      return { kind: "value", field, value: Number(digits) };
    }
  }
  return void 0;
}
const CODECS = { a9, i3 };
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CODECS,
  a9,
  i3
});
//# sourceMappingURL=protocol.js.map
