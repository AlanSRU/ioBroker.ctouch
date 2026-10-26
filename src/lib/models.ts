/*
 * Supported display models, from the manufacturer's RS-232 documents (see docs/README.md).
 * A model is added only from a protocol document; input codes are copied, never extrapolated
 * (Laser Nova HDMI 3 is 0x08, not 0x07).
 */
import type { ProtocolName } from './protocol';

/** One selectable input of a model. */
export interface InputDef {
    /** the display's own input code */
    code: number;
    /** label shown for the input */
    name: string;
}

/** A display model, from its protocol document. */
export interface ModelDef {
    /** product name */
    name: string;
    /** protocol family */
    protocol: ProtocolName;
    /** factory serial speed; the converter must match (the display's menu can change it) */
    baud: number;
    /** TCP port of the display's own RS-232-over-IP, or undefined when the document gives none */
    networkPort?: number;
    /** selectable inputs, in the order offered */
    inputs: InputDef[];
    /** source document */
    document: string;
}

export const MODELS: Record<string, ModelDef> = {
    laserNova: {
        name: 'CTOUCH Laser Nova',
        protocol: 'a9',
        baud: 9600,
        networkPort: 5000,
        document: 'RS-232 protocol for CTOUCH Laser Nova + Laser Sky V4.02',
        inputs: [
            { code: 0x05, name: 'HDMI 1' },
            { code: 0x06, name: 'HDMI 2' },
            { code: 0x08, name: 'HDMI 3' },
            { code: 0x07, name: 'DisplayPort' },
            { code: 0x14, name: 'VGA' },
            { code: 0x09, name: 'Inside PC' },
            { code: 0x0d, name: 'Android' },
            { code: 0x0c, name: 'Home' },
        ],
    },
    laserSky: {
        name: 'CTOUCH Laser Sky',
        protocol: 'a9',
        baud: 9600,
        networkPort: 5000,
        document: 'RS-232 protocol for CTOUCH Laser Nova + Laser Sky V4.02',
        inputs: [
            { code: 0x05, name: 'HDMI 1' },
            { code: 0x06, name: 'HDMI 2' },
            { code: 0x08, name: 'HDMI 3' },
            // 0x0D is HDMI 4 on the Sky (with the Wi-Fi module), Android on the Nova
            { code: 0x0d, name: 'HDMI 4' },
            { code: 0x07, name: 'DisplayPort' },
            { code: 0x14, name: 'VGA' },
            { code: 0x09, name: 'Inside PC' },
            { code: 0x0c, name: 'Home' },
        ],
    },
    rivaR2: {
        name: 'CTOUCH Riva R2',
        protocol: 'a9',
        baud: 9600,
        networkPort: 5000,
        document: 'CTOUCH Riva R2 RS232 protocol V230414',
        inputs: [
            { code: 0x05, name: 'HDMI 1' },
            { code: 0x06, name: 'HDMI 2' },
            { code: 0x08, name: 'HDMI 3' },
            { code: 0x07, name: 'DisplayPort' },
            // the document gives 0x0E for both USB-C ports
            { code: 0x0e, name: 'USB-C' },
            { code: 0x14, name: 'VGA' },
            { code: 0x01, name: 'AV' },
            { code: 0x09, name: 'Inside PC' },
            { code: 0x0c, name: 'Android' },
        ],
    },
    neo: {
        name: 'CTOUCH Neo',
        protocol: 'a9',
        baud: 115200,
        document: 'Neo RS232 specification v1.3',
        inputs: [
            { code: 0x05, name: 'HDMI 1' },
            { code: 0x06, name: 'HDMI 2' },
            { code: 0x08, name: 'HDMI 3' },
            { code: 0x07, name: 'DisplayPort' },
            { code: 0x0e, name: 'USB-C' },
            { code: 0x09, name: 'OPS' },
            { code: 0x0c, name: 'Android' },
        ],
    },
    cactus: {
        name: 'i3-CONNECT Cactus',
        protocol: 'i3',
        baud: 9600,
        networkPort: 4664,
        document: 'i3CONNECT RS232 Specification Cactus v1.2',
        inputs: [
            { code: 1, name: 'HDMI 1' },
            { code: 2, name: 'HDMI 2' },
            { code: 21, name: 'HDMI 3' },
            { code: 22, name: 'HDMI 4' },
            { code: 101, name: 'Android' },
        ],
    },
    veneer2: {
        name: 'i3-CONNECT Veneer 2',
        protocol: 'i3',
        baud: 9600,
        networkPort: 4664,
        document: 'i3CONNECT RS232 Specification Veneer 2 v1.0',
        inputs: [
            { code: 1, name: 'HDMI 1' },
            { code: 2, name: 'HDMI 2' },
            { code: 21, name: 'HDMI 3' },
            { code: 7, name: 'DisplayPort' },
            { code: 104, name: 'USB-C 1' },
            { code: 105, name: 'USB-C 2' },
            { code: 0, name: 'VGA' },
            { code: 103, name: 'Slot-in PC' },
            { code: 101, name: 'Android' },
        ],
    },
};

export const DEFAULT_MODEL = 'laserNova';

/**
 * An input code as the input state holds it: two hex digits for the a9 family ("05"), three
 * decimal digits for i3 ("021") — each the way the manufacturer's document writes it.
 *
 * @param protocol - protocol family
 * @param code - the display's input code
 */
export function formatInput(protocol: ProtocolName, code: number): string {
    return protocol === 'a9' ? code.toString(16).toUpperCase().padStart(2, '0') : String(code).padStart(3, '0');
}

/**
 * The display's input code for a state value, or undefined if it is not a valid code.
 *
 * @param protocol - protocol family
 * @param value - state value, e.g. "05", "5", "021", 21
 */
export function parseInput(protocol: ProtocolName, value: unknown): number | undefined {
    const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
    if (protocol === 'a9') {
        return /^[0-9a-f]{1,2}$/i.test(text) ? parseInt(text, 16) : undefined;
    }
    return /^\d{1,3}$/.test(text) ? Number(text) : undefined;
}
