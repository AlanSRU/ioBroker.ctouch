/*
 * Wake-on-LAN. Over the network every family ignores commands in standby, so a display connected
 * directly (not through a serial converter) can only be switched on with a magic packet.
 */
import { createSocket } from 'node:dgram';

/**
 * The six MAC bytes, or undefined when the text is not a MAC address.
 *
 * @param mac - e.g. "AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff" or "aabbccddeeff"
 */
export function parseMac(mac: string): Buffer | undefined {
    const hex = mac.trim().replace(/[:-]/g, '');
    return /^[0-9a-f]{12}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined;
}

/**
 * The 102-byte magic packet: six 0xFF, then the MAC sixteen times.
 *
 * @param mac - the six MAC bytes
 */
export function magicPacket(mac: Buffer): Buffer {
    return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(mac)]);
}

/**
 * Broadcast a magic packet to UDP port 9.
 *
 * @param mac - the six MAC bytes
 * @param address - broadcast address
 */
export async function wake(mac: Buffer, address = '255.255.255.255'): Promise<void> {
    const socket = createSocket('udp4');
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once('error', reject);
            socket.bind(() => {
                socket.setBroadcast(true);
                socket.send(magicPacket(mac), 9, address, error => (error ? reject(error) : resolve()));
            });
        });
    } finally {
        socket.close();
    }
}
