/*
 * A CTOUCH / i3-CONNECT display simulator for tests and for trying the adapter without hardware.
 * Not part of the adapter build. Behaves as the manufacturer's documents describe.
 *
 * Standalone:  npx ts-node test/lib/simulator.ts [port] [a9|i3] [id]
 *   e.g.       npx ts-node test/lib/simulator.ts 5000 a9 9
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { ProtocolName } from '../../src/lib/protocol';

/** What the simulated display is set to. */
export interface SimState {
    /** power */
    power: boolean;
    /** volume, 0-100 */
    volume: number;
    /** mute */
    mute: boolean;
    /** input code */
    input: number;
}

/** How the simulated display behaves. */
export interface SimOptions {
    /** protocol family */
    protocol: ProtocolName;
    /** the display's Set ID */
    id: number;
    /** input codes the display accepts; anything else is refused */
    inputs: number[];
    /** delay before answering a switch to the input already showing (real displays: ~3 s) */
    sameInputDelayMs?: number;
}

/** A display on a local TCP port, answering as the documents describe. */
export class DisplaySimulator {
    public state: SimState = { power: false, volume: 20, mute: false, input: 0 };
    /** every request received, as hex */
    public received: string[] = [];
    /** swallow the next N requests without answering (display busy) */
    public busy = 0;
    /** stop answering altogether */
    public silent = false;
    private server?: Server;
    private readonly sockets = new Set<Socket>();

    /** @param options - how the display behaves */
    public constructor(private readonly options: SimOptions) {
        this.state.input = options.inputs[0];
    }

    /**
     * Start listening; resolves with the port.
     *
     * @param port - TCP port, 0 for any free one
     */
    public async listen(port = 0): Promise<number> {
        this.server = createServer(socket => this.onConnection(socket));
        await new Promise<void>(resolve => this.server!.listen(port, '127.0.0.1', resolve));
        return (
            this.server.address() as {
                port: number;
            }
        ).port;
    }

    /** Stop listening and drop every connection. */
    public async close(): Promise<void> {
        this.sockets.forEach(s => s.destroy());
        await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
    }

    /** Drop every client connection (a converter or display going away). */
    public dropConnections(): void {
        this.sockets.forEach(s => s.destroy());
    }

    private onConnection(socket: Socket): void {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        let buf: Buffer = Buffer.alloc(0);
        socket.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            buf = this.options.protocol === 'a9' ? this.consumeA9(socket, buf) : this.consumeI3(socket, buf);
        });
    }

    private shouldIgnore(frame: Buffer): boolean {
        this.received.push(frame.toString('hex'));
        if (this.silent) {
            return true;
        }
        if (this.busy > 0) {
            this.busy--;
            return true;
        }
        return false;
    }

    // ── a9 ────────────────────────────────────────────────────────────────────

    private consumeA9(socket: Socket, input: Buffer): Buffer {
        let buf = input;
        while (buf.length >= 5) {
            const frame = buf.subarray(0, 5);
            buf = buf.subarray(5);
            const [start, cmd, id, data, end] = frame;
            if (start !== 0xa9 || end !== 0x8a || this.shouldIgnore(frame)) {
                continue;
            }
            const reply = (kind: number, value: number): void => {
                socket.write(Buffer.from([0xa9, kind, id, cmd, value, 0x8a]));
            };
            if (id !== this.options.id) {
                continue; // another display's request (00 would broadcast, and is never answered)
            }
            const field = { 0x11: 'power', 0x13: 'volume', 0x14: 'mute', 0x15: 'input' }[cmd] as keyof SimState;
            if (!field) {
                reply(0x4e, 0x01);
                continue;
            }
            if (data === 0xaa) {
                reply(0x41, this.read(field));
                continue;
            }
            const error = this.write(field, data);
            if (error) {
                reply(0x4e, error);
                continue;
            }
            const same = field === 'input' && this.wasSameInput;
            setTimeout(() => reply(0x41, data), same ? (this.options.sameInputDelayMs ?? 3000) : 10);
        }
        return buf;
    }

    // ── i3 ────────────────────────────────────────────────────────────────────

    private consumeI3(socket: Socket, input: Buffer): Buffer {
        let buf = input;
        for (let end = buf.indexOf(0x0d); end >= 0; end = buf.indexOf(0x0d)) {
            const line = buf.subarray(0, end);
            buf = buf.subarray(end + 1);
            if (line.length !== 8 || line[0] !== 0x3a || this.shouldIgnore(line)) {
                continue;
            }
            const id = Number(line.subarray(1, 3).toString('ascii'));
            if (id !== this.options.id) {
                continue;
            }
            const idText = line.subarray(1, 3).toString('ascii');
            const op = String.fromCharCode(line[3]);
            const cmd = line[4];
            const value = Number(line.subarray(5, 8).toString('ascii'));
            const field = { 0x30: 'power', 0x38: 'volume', 0x39: 'mute', 0x3a: 'input' }[cmd] as keyof SimState;
            const nak = (): boolean => socket.write(`4${idText}-\r`);
            if (!field) {
                nak();
                continue;
            }
            if (op === 'G') {
                const v = field === 'power' ? (this.state.power ? 1 : 2) : this.read(field);
                socket.write(`:${idText}r${String.fromCharCode(cmd)}${String(v).padStart(3, '0')}\r`);
                continue;
            }
            const data = field === 'power' ? (value === 3 ? 1 : value === 2 ? 0 : 0xff) : value;
            if (data === 0xff || this.write(field, data)) {
                nak();
                continue;
            }
            const same = field === 'input' && this.wasSameInput;
            setTimeout(() => socket.write(`4${idText}+\r`), same ? (this.options.sameInputDelayMs ?? 3000) : 10);
        }
        return buf;
    }

    // ── shared ────────────────────────────────────────────────────────────────

    private wasSameInput = false;

    private read(field: keyof SimState): number {
        const v = this.state[field];
        return typeof v === 'boolean' ? (v ? 1 : 0) : v;
    }

    /**
     * Apply a set; returns a NAK error code, or 0 when accepted.
     *
     * @param field - what is being set
     * @param data - the requested value
     */
    private write(field: keyof SimState, data: number): number {
        if (field === 'power' || field === 'mute') {
            if (data > 1) {
                return 0x02;
            }
            this.state[field] = data === 1;
        } else if (field === 'volume') {
            if (data > 100) {
                return 0x02;
            }
            this.state.volume = data;
        } else {
            if (!this.options.inputs.includes(data)) {
                return 0x02;
            }
            this.wasSameInput = this.state.input === data;
            this.state.input = data;
        }
        return 0;
    }
}

if (require.main === module) {
    const [port = '5000', protocol = 'a9', id = '9'] = process.argv.slice(2);
    const inputs = protocol === 'a9' ? [0x05, 0x06, 0x08, 0x07, 0x09, 0x0c, 0x0d, 0x14] : [1, 2, 21, 22, 101];
    const sim = new DisplaySimulator({ protocol: protocol as ProtocolName, id: Number(id), inputs });
    void sim.listen(Number(port)).then(p => console.log(`${protocol} display simulator, Set ID ${id}, on port ${p}`));
}
