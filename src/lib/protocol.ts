/*
 * The two RS-232 protocol families used by CTOUCH / i3-CONNECT displays, as codecs:
 * turn a request into bytes, and bytes back into replies. No I/O here.
 *
 * "a9"  CTOUCH binary (Laser Nova + Laser Sky V4.02, Riva R2 V230414, Neo v1.3)
 *       request  A9 <cmd> <ID> <data> 8A        query: data = AA
 *       ACK      A9 41 <ID> <cmd> <data> 8A     data = value set, or the current value
 *       NAK      A9 4E <ID> <cmd> <err> 8A      01 invalid command, 02 invalid data
 *       ID 00 broadcasts and is never acknowledged; 00, 8A and A9 are not valid IDs.
 *
 * "i3"  i3-CONNECT ASCII (Cactus v1.2, Veneer 2 v1.0)
 *       set      3A <ID ID> 53 <cmd> <d d d> 0D    ":01S8050\r"  (ID and data as ASCII digits)
 *       get      3A <ID ID> 47 <cmd> 30 30 30 0D   ":01G8000\r"
 *       value    3A <ID ID> 72 <cmd> <d d d> 0D    ":01r8050\r"  (the answer to a get)
 *       ACK      34 <ID ID> 2B 0D                  "401+\r"      (to a set; carries no value)
 *       NAK      34 <ID ID> 2D 0D                  "401-\r"
 */

/** What the adapter controls. Every family supports all four. */
export type Field = 'power' | 'volume' | 'mute' | 'input';
export const FIELDS: readonly Field[] = ['power', 'volume', 'mute', 'input'];

export type ProtocolName = 'a9' | 'i3';

/**
 * A decoded reply.
 * - `value`: the display reported this field's value (an a9 ACK, or an i3 get reply)
 * - `ack`:   the display accepted the last set but did not echo a value (i3)
 * - `nak`:   the display refused the last request
 */
export type Reply =
    { kind: 'value'; field: Field; value: number } | { kind: 'ack' } | { kind: 'nak'; field?: Field; reason: string };

/** What one call to `decode` found. */
export interface DecodeResult {
    /** complete replies, in order */
    replies: Reply[];
    /** bytes not yet forming a complete reply, to prepend to the next chunk */
    rest: Buffer;
    /** bytes thrown away while resynchronising, for logging */
    discarded: Buffer[];
}

/** One protocol family: requests to bytes, bytes to replies. */
export interface Codec {
    /** the family */
    readonly name: ProtocolName;
    /** Device value for "power on" / "power off". */
    powerValue(on: boolean): number;
    /** Whether a reported power value means the display is on. */
    isPowerOn(value: number): boolean;
    /** The bytes that set a field. */
    encodeSet(field: Field, value: number, id: number): Buffer;
    /** The bytes that ask for a field's current value. */
    encodeQuery(field: Field, id: number): Buffer;
    /** Split received bytes into complete replies. */
    decode(buffer: Buffer): DecodeResult;
    /** Validate a Set ID; returns an error message, or undefined when fine. */
    checkId(id: number): string | undefined;
}

// ── a9: CTOUCH binary ─────────────────────────────────────────────────────────

const A9_START = 0xa9;
const A9_END = 0x8a;
const A9_QUERY = 0xaa;
const A9_ACK = 0x41;
const A9_NAK = 0x4e;
const A9_CMD: Record<Field, number> = { power: 0x11, volume: 0x13, mute: 0x14, input: 0x15 };
const A9_FIELD = new Map(Object.entries(A9_CMD).map(([field, cmd]) => [cmd, field as Field]));

function errorText(code: number): string {
    return code === 0x01 ? 'invalid command' : code === 0x02 ? 'invalid data' : `error 0x${hex2(code)}`;
}

function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, '0');
}

export const a9: Codec = {
    name: 'a9',
    powerValue: on => (on ? 0x01 : 0x00),
    isPowerOn: value => value === 0x01,
    encodeSet: (field, value, id) => Buffer.from([A9_START, A9_CMD[field], id, value, A9_END]),
    encodeQuery: (field, id) => Buffer.from([A9_START, A9_CMD[field], id, A9_QUERY, A9_END]),
    checkId: id =>
        !Number.isInteger(id) || id < 1 || id > 255
            ? 'Set ID must be 1-255'
            : id === A9_START || id === A9_END
              ? 'Set ID 138 (0x8A) and 168 (0xA9) are reserved by the protocol'
              : undefined,
    decode(buffer) {
        const replies: Reply[] = [];
        const discarded: Buffer[] = [];
        let buf = buffer;
        for (;;) {
            // Resynchronise on the start byte, so one stray byte cannot shift every later frame.
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
            if (frame[5] !== A9_END || (frame[1] !== A9_ACK && frame[1] !== A9_NAK)) {
                discarded.push(buf.subarray(0, 1));
                buf = buf.subarray(1);
                continue;
            }
            buf = buf.subarray(6);
            const field = A9_FIELD.get(frame[3]);
            if (frame[1] === A9_NAK) {
                replies.push({ kind: 'nak', field, reason: errorText(frame[4]) });
            } else if (field) {
                replies.push({ kind: 'value', field, value: frame[4] });
            }
        }
    },
};

// ── i3: i3-CONNECT ASCII ──────────────────────────────────────────────────────

const I3_START = 0x3a; // ':'
const I3_REPLY_START = 0x34; // '4'
const I3_END = 0x0d;
const I3_CMD: Record<Field, number> = { power: 0x30, volume: 0x38, mute: 0x39, input: 0x3a };
const I3_FIELD = new Map(Object.entries(I3_CMD).map(([field, cmd]) => [cmd, field as Field]));
/** Power set values: 002 off, 003 on. Reported: 000 backlight off, 001 backlight on, 002 off. */
const I3_POWER_OFF = 2;
const I3_POWER_ON = 3;

function idDigits(id: number): Buffer {
    return Buffer.from(String(id).padStart(2, '0'), 'ascii');
}

function threeDigits(value: number): Buffer {
    return Buffer.from(String(value).padStart(3, '0'), 'ascii');
}

export const i3: Codec = {
    name: 'i3',
    powerValue: on => (on ? I3_POWER_ON : I3_POWER_OFF),
    // A dark backlight (000) is still a display that is on.
    isPowerOn: value => value === 0 || value === 1 || value === I3_POWER_ON,
    encodeSet: (field, value, id) =>
        Buffer.concat([
            Buffer.from([I3_START]),
            idDigits(id),
            Buffer.from([0x53, I3_CMD[field]]),
            threeDigits(value),
            Buffer.from([I3_END]),
        ]),
    encodeQuery: (field, id) =>
        Buffer.concat([
            Buffer.from([I3_START]),
            idDigits(id),
            Buffer.from([0x47, I3_CMD[field]]),
            threeDigits(0),
            Buffer.from([I3_END]),
        ]),
    checkId: id => (!Number.isInteger(id) || id < 1 || id > 99 ? 'Set ID must be 1-99' : undefined),
    decode(buffer) {
        const replies: Reply[] = [];
        const discarded: Buffer[] = [];
        let buf = buffer;
        for (;;) {
            const end = buf.indexOf(I3_END);
            if (end < 0) {
                // no complete line yet; a runaway line without CR is dropped rather than grown forever
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
    },
};

function parseI3Line(line: Buffer): Reply | undefined {
    // ACK / NAK: '4' ID ID '+' | '-'
    if (line.length === 4 && line[0] === I3_REPLY_START) {
        if (line[3] === 0x2b) {
            return { kind: 'ack' };
        }
        if (line[3] === 0x2d) {
            return { kind: 'nak', reason: 'refused' };
        }
    }
    // value: ':' ID ID 'r' cmd d d d
    if (line.length === 8 && line[0] === I3_START && line[3] === 0x72) {
        const field = I3_FIELD.get(line[4]);
        const digits = line.subarray(5, 8).toString('ascii');
        if (field && /^\d{3}$/.test(digits)) {
            return { kind: 'value', field, value: Number(digits) };
        }
    }
    return undefined;
}

export const CODECS: Record<ProtocolName, Codec> = { a9, i3 };
