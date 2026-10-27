/*
 * One display connection: a persistent TCP socket to an RS-232-to-Ethernet converter, or to the
 * display's own RS-232-over-IP port. Ported from the venue script ctouch-interface.js.
 *
 * The manufacturer's rules, shared by every family:
 * - one request at a time; the next waits for the reply to the last
 * - no reply within 500 ms means the display was busy: retry once
 * - re-selecting the input already showing is answered only after ~3 s (caller passes a longer timeout)
 *
 * The client never reports a value it sent as fact. It emits `value` only for what the display
 * reported: the echo in an a9 ACK, an i3 query reply, or an i3 ACK to a set (which accepts the
 * value without echoing it).
 */
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import type { Codec, Field, Reply } from './protocol';

/** Timer functions, so the adapter can supply its own (cleared on unload). */
export interface Timers {
    /** Schedule a callback. */
    setTimeout(callback: () => void, ms: number): unknown;
    /** Cancel a scheduled callback. */
    clearTimeout(handle: unknown): void;
}

/** How to reach one display. */
export interface ClientOptions {
    /** converter or display address */
    host: string;
    /** TCP port */
    port: number;
    /** the display's protocol family */
    codec: Codec;
    /** the display's Set ID */
    id: number;
    /** reply timeout, 500 ms by the manufacturer's rules */
    replyTimeoutMs?: number;
    /** delay before reconnecting a dropped link */
    reconnectMs?: number;
    /** unanswered queries in a row before the display counts as not answering */
    offlineAfterMissedQueries?: number;
    /** the adapter passes its own, so they are cleared on unload */
    timers?: Timers;
}

/** Events, as listener argument tuples. */
export interface ClientEvents {
    /** the display reported a value */
    value: [field: Field, value: number];
    /** the display refused a request */
    refused: [field: Field, reason: string, wasQuery: boolean];
    /** a set got no reply, even after the retry */
    noReply: [field: Field];
    /** a set could not be sent at all */
    notSent: [field: Field, reason: string];
    /** the TCP link came up or went down */
    link: [up: boolean];
    /** the display started or stopped answering */
    answering: [answering: boolean];
    /** bytes that were not a reply, for debug logging */
    discarded: [bytes: Buffer];
}

interface Request {
    field: Field;
    /** undefined for a query */
    value?: number;
    timeoutMs: number;
    retried: boolean;
    timer?: unknown;
}

const REPLY_TIMEOUT_MS = 500;
const RECONNECT_MS = 10_000;
/** About two status rounds (four or five queries each). */
const OFFLINE_AFTER_MISSED = 8;

/** One display connection: requests go out one at a time, each waiting for its reply. */
export class DisplayClient extends EventEmitter<ClientEvents> {
    private socket?: Socket;
    private linkUp = false;
    private isAnswering = false;
    private stopped = true;
    private reconnectTimer?: unknown;
    private rx: Buffer = Buffer.alloc(0);
    private readonly queue: Request[] = [];
    private inFlight?: Request;
    private missedQueries = 0;
    private readonly timers: Timers;

    /** @param options - how to reach the display */
    public constructor(private readonly options: ClientOptions) {
        super();
        this.timers = options.timers ?? {
            setTimeout: (callback, ms) => setTimeout(callback, ms),
            clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
        };
    }

    /** Whether the display is answering. */
    public get answering(): boolean {
        return this.isAnswering;
    }

    /** Whether the TCP link is up. */
    public get connected(): boolean {
        return this.linkUp;
    }

    /** Connect, and keep reconnecting until stopped. */
    public start(): void {
        this.stopped = false;
        this.connect();
    }

    /** Disconnect and drop everything pending. */
    public stop(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            this.timers.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.clearPending();
        this.socket?.destroy();
        this.socket = undefined;
    }

    /**
     * Set a value. A newer set of the same field replaces one still waiting (a dragged slider);
     * key presses are all sent (three presses of Down move three places).
     *
     * @param field - what to set
     * @param value - the device value
     * @param timeoutMs - reply timeout, longer when re-selecting the current input
     */
    public set(field: Field, value: number, timeoutMs = this.options.replyTimeoutMs ?? REPLY_TIMEOUT_MS): void {
        const waiting = field === 'key' ? -1 : this.queue.findIndex(r => r.field === field && r.value !== undefined);
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
    public query(field: Field): void {
        if (this.queue.some(r => r.field === field && r.value === undefined)) {
            return;
        }
        this.enqueue({ field, timeoutMs: this.options.replyTimeoutMs ?? REPLY_TIMEOUT_MS, retried: false });
    }

    /** Whether nothing is queued or waiting for a reply. */
    public get idle(): boolean {
        return !this.inFlight && !this.queue.length;
    }

    // ── connection ────────────────────────────────────────────────────────────

    private connect(): void {
        if (this.stopped) {
            return;
        }
        this.rx = Buffer.alloc(0);
        const socket = new Socket();
        this.socket = socket;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        socket.on('connect', () => {
            this.linkUp = true;
            this.emit('link', true);
            this.sendNext();
        });
        socket.on('data', chunk => this.onData(chunk));
        // 'close' always follows 'error'; reconnecting is handled there
        socket.on('error', () => undefined);
        socket.on('close', () => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = undefined;
            const wasUp = this.linkUp;
            this.linkUp = false;
            if (wasUp) {
                this.emit('link', false);
            }
            this.setAnswering(false);
            this.failAll('connection lost');
            if (!this.stopped) {
                this.reconnectTimer = this.timers.setTimeout(() => {
                    this.reconnectTimer = undefined;
                    this.connect();
                }, this.options.reconnectMs ?? RECONNECT_MS);
            }
        });
        socket.connect(this.options.port, this.options.host);
    }

    private setAnswering(answering: boolean): void {
        if (this.isAnswering !== answering) {
            this.isAnswering = answering;
            this.emit('answering', answering);
        }
    }

    // ── replies ───────────────────────────────────────────────────────────────

    private onData(chunk: Buffer): void {
        const { replies, rest, discarded } = this.options.codec.decode(Buffer.concat([this.rx, chunk]));
        this.rx = rest;
        discarded.forEach(bytes => this.emit('discarded', bytes));
        replies.forEach(reply => this.onReply(reply));
    }

    private onReply(reply: Reply): void {
        const request = this.inFlight;
        // a reply naming another field is not ours (a late answer to a request that timed out)
        if (!request || ('field' in reply && reply.field && reply.field !== request.field)) {
            return;
        }
        this.timers.clearTimeout(request.timer);
        this.inFlight = undefined;
        this.missedQueries = 0;
        this.setAnswering(true);

        if (reply.kind === 'value') {
            this.emit('value', reply.field, reply.value);
        } else if (reply.kind === 'ack') {
            // i3 accepts a set without echoing it; a query is answered by a value line instead
            if (request.value !== undefined) {
                this.emit('value', request.field, request.value);
            }
        } else {
            this.emit('refused', request.field, reply.reason, request.value === undefined);
        }
        this.sendNext();
    }

    // ── sending ───────────────────────────────────────────────────────────────

    private enqueue(request: Request): void {
        this.queue.push(request);
        this.sendNext();
    }

    private sendNext(): void {
        if (this.inFlight || !this.queue.length) {
            return;
        }
        if (!this.linkUp || !this.socket) {
            this.failAll('not connected');
            return;
        }
        this.transmit(this.queue.shift()!);
    }

    private transmit(request: Request): void {
        const { codec, id } = this.options;
        this.inFlight = request;
        this.socket!.write(
            request.value === undefined
                ? codec.encodeQuery(request.field, id)
                : codec.encodeSet(request.field, request.value, id),
        );
        request.timer = this.timers.setTimeout(() => this.onTimeout(request), request.timeoutMs);
    }

    private onTimeout(request: Request): void {
        if (this.inFlight !== request) {
            return;
        }
        if (!request.retried && this.socket) {
            request.retried = true;
            this.transmit(request);
            return;
        }
        this.inFlight = undefined;
        if (request.value === undefined) {
            this.missedQueries++;
            if (this.missedQueries >= (this.options.offlineAfterMissedQueries ?? OFFLINE_AFTER_MISSED)) {
                this.setAnswering(false);
            }
        } else {
            this.emit('noReply', request.field);
        }
        this.sendNext();
    }

    /**
     * Drop everything pending. Queries are dropped quietly; sets are reported.
     *
     * @param reason - why, for the notSent event
     */
    private failAll(reason: string): void {
        const dropped = this.clearPending();
        dropped.filter(r => r.value !== undefined).forEach(r => this.emit('notSent', r.field, reason));
    }

    private clearPending(): Request[] {
        const dropped = [...(this.inFlight ? [this.inFlight] : []), ...this.queue.splice(0)];
        if (this.inFlight) {
            this.timers.clearTimeout(this.inFlight.timer);
            this.inFlight = undefined;
        }
        return dropped;
    }
}
