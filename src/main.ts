/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * ioBroker adapter for CTOUCH / i3-CONNECT interactive displays over their RS-232 protocols,
 * through a serial-to-Ethernet converter or the display's own RS-232-over-IP port.
 *
 * One instance drives any number of displays, each in its own device folder. Every value in the
 * object tree comes from the display: a write is acknowledged only when the display confirms it,
 * and the four controls are re-read every poll interval, because no family reports a change made
 * with the display's own remote by itself.
 */
import * as utils from '@iobroker/adapter-core';
import { DisplayClient } from './lib/client';
import { DEFAULT_MODEL, MODELS, formatInput, parseInput, type ModelDef } from './lib/models';
import { CODECS, FIELDS, type Codec, type Field } from './lib/protocol';
import { parseMac, wake } from './lib/wol';

/** Object ids that belong to the instance itself and cannot name a display. */
const RESERVED_IDS = ['info'];

/** Reply timeout when re-selecting the input already showing ("will respond after 3 seconds"). */
const SAME_INPUT_TIMEOUT_MS = 3500;

/** One row of the display table in the instance configuration. */
interface DeviceConfig {
    enabled?: boolean;
    name?: string;
    model?: string;
    /** "converter" (serial-to-Ethernet) or "network" (the display's own port) */
    connection?: string;
    host?: string;
    port?: number;
    displayId?: number;
    mac?: string;
}

/** A configured display and its runtime state. */
interface Display {
    /** object-tree id, e.g. "cap_thistle" */
    id: string;
    label: string;
    model: ModelDef;
    codec: Codec;
    network: boolean;
    mac?: Buffer;
    client: DisplayClient;
    /** the input the display last reported */
    confirmedInput?: number;
}

class Ctouch extends utils.Adapter {
    private displays = new Map<string, Display>();
    /** ids of disabled displays, whose objects are kept */
    private disabledIds = new Set<string>();
    private pollTimer?: ioBroker.Interval;
    /** set first thing in onUnload, so a still-running onReady stops before opening connections */
    private stopped = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'ctouch',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);

        this.buildDisplays();
        await this.removeStaleObjects();
        for (const d of this.displays.values()) {
            await this.createObjects(d);
            await this.setState(`${d.id}.info.connection`, { val: false, ack: true });
        }
        for (const id of this.disabledIds) {
            // not connected while disabled, so do not leave it looking reachable
            if (await this.getObjectAsync(`${id}.info.connection`)) {
                await this.setState(`${id}.info.connection`, { val: false, ack: true });
            }
        }
        if (this.stopped) {
            return;
        }
        this.subscribeStates('*.control.*');

        if (!this.displays.size) {
            this.log.warn('No displays configured — open the instance settings and add at least one.');
            return;
        }
        for (const d of this.displays.values()) {
            d.client.start();
        }
        const pollMs = Math.min(3600, Math.max(5, Number(this.config.pollInterval) || 30)) * 1000;
        this.pollTimer = this.setInterval(() => {
            for (const d of this.displays.values()) {
                // a display busy with commands is already reporting fresh values
                if (d.client.connected && d.client.idle) {
                    this.queryAll(d);
                }
            }
        }, pollMs);
    }

    /** Turn the configured display table into runtime displays. */
    private buildDisplays(): void {
        const devices = (this.config.devices ?? []) as unknown as DeviceConfig[];
        for (const device of devices) {
            const host = (device.host || '').trim();
            const label = (device.name || '').trim() || host;
            if (!host) {
                this.log.warn(`Ignoring display "${label || '(unnamed)'}": no host configured.`);
                continue;
            }
            const id = this.makeId(label);
            if (device.enabled === false) {
                // keep its objects (and their history/alias settings) for when it is re-enabled
                this.disabledIds.add(id);
                continue;
            }
            const modelId = device.model && MODELS[device.model] ? device.model : DEFAULT_MODEL;
            const model = MODELS[modelId];
            const codec = CODECS[model.protocol];
            const network = device.connection === 'network';
            const port = Number(device.port) || (network ? model.networkPort : undefined);
            if (!port) {
                this.log.warn(
                    `Ignoring display "${label}": ${network ? `${model.name} has no documented network port` : 'no converter port configured'}.`,
                );
                continue;
            }
            const displayId = Number(device.displayId);
            const idError = codec.checkId(displayId);
            if (idError) {
                this.log.warn(`Ignoring display "${label}": ${idError} (the Set ID in the display's menu).`);
                continue;
            }
            const mac = device.mac ? parseMac(device.mac) : undefined;
            if (device.mac && !mac) {
                this.log.warn(`Display "${label}": "${device.mac}" is not a MAC address; Wake-on-LAN is disabled.`);
            }
            if (network && !mac) {
                this.log.info(
                    `Display "${label}": no MAC address, so it cannot be switched on over the network (Wake-on-LAN).`,
                );
            }

            const client = new DisplayClient({
                host,
                port,
                codec,
                id: displayId,
                timers: {
                    setTimeout: (callback, ms) => this.setTimeout(callback, ms),
                    clearTimeout: handle => this.clearTimeout(handle as ioBroker.Timeout),
                },
            });
            const display: Display = { id, label, model, codec, network, mac, client };
            this.attach(display);
            this.displays.set(id, display);
            this.log.info(
                `Display "${label}" (${model.name}, Set ID ${displayId}) -> ${this.namespace}.${id} via ` +
                    `${network ? 'its network port' : 'a serial converter'} ${host}:${port}`,
            );
        }
    }

    /**
     * Derive a unique object id from a display name. Lower case, so that names differing only in
     * case do not fork into two object trees.
     *
     * @param label - display name or host
     */
    private makeId(label: string): string {
        const base =
            label
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, '_')
                .replace(/^_+|_+$/g, '') || 'display';
        let id = RESERVED_IDS.includes(base) ? `${base}_display` : base;
        for (let suffix = 2; this.displays.has(id) || this.disabledIds.has(id); suffix++) {
            id = `${base}_${suffix}`;
        }
        return id;
    }

    /** Delete device folders of displays that are no longer configured. */
    private async removeStaleObjects(): Promise<void> {
        for (const obj of await this.getDevicesAsync()) {
            const id = obj._id.substring(this.namespace.length + 1);
            if (!id.includes('.') && !this.displays.has(id) && !this.disabledIds.has(id)) {
                this.log.info(`Removing objects of display "${id}", which is no longer configured.`);
                await this.delObjectAsync(id, { recursive: true });
            }
        }
    }

    private async createObjects(d: Display): Promise<void> {
        await this.extendObject(d.id, { type: 'device', common: { name: d.label }, native: {} });
        await this.extendObject(`${d.id}.control`, { type: 'channel', common: { name: 'Control' }, native: {} });
        await this.extendObject(`${d.id}.info`, { type: 'channel', common: { name: 'Information' }, native: {} });

        const state = async (id: string, common: Partial<ioBroker.StateCommon>): Promise<void> => {
            // extendObject, so a changed model updates the input list of an existing tree
            await this.extendObject(`${d.id}.${id}`, {
                type: 'state',
                common: { read: true, write: false, ...common } as ioBroker.StateCommon,
                native: {},
            });
        };
        await state('control.power', { name: 'Power', type: 'boolean', role: 'switch.power', write: true });
        await state('control.volume', {
            name: 'Volume',
            type: 'number',
            role: 'level.volume',
            min: 0,
            max: 100,
            unit: '%',
            write: true,
        });
        await state('control.mute', { name: 'Mute', type: 'boolean', role: 'media.mute', write: true });
        await state('control.input', {
            name: 'Input',
            type: 'string',
            role: 'media.input',
            write: true,
            states: Object.fromEntries(d.model.inputs.map(i => [formatInput(d.model.protocol, i.code), i.name])),
        });
        await state('info.connection', {
            name: 'Display answering',
            type: 'boolean',
            role: 'indicator.connected',
            def: false,
        });
        await state('info.lastError', { name: 'Why the last command did not complete', type: 'string', role: 'text' });
        await state('info.model', { name: 'Model', type: 'string', role: 'info.name' });
        await this.setState(`${d.id}.info.model`, { val: d.model.name, ack: true });
    }

    /**
     * Wire a display's client events into its states.
     *
     * @param d - the display
     */
    private attach(d: Display): void {
        const c = d.client;
        c.on('link', up => {
            this.log.debug(`[${d.label}] ${up ? 'connected to' : 'lost'} ${d.network ? 'display' : 'converter'}`);
            if (up) {
                this.queryAll(d);
            }
        });
        c.on('answering', answering => void this.onAnswering(d, answering));
        c.on('value', (field, value) => void this.onValue(d, field, value));
        c.on('refused', (field, reason, wasQuery) => {
            if (wasQuery) {
                this.log.debug(`[${d.label}] does not answer a ${field} query: ${reason}`);
                return;
            }
            void this.fail(d, `${field}: display refused it (${reason})`, field);
        });
        c.on('noReply', field => void this.fail(d, `${field}: no reply from the display`, field));
        c.on('notSent', (field, reason) => void this.fail(d, `${field}: not sent, ${reason}`));
        c.on('discarded', bytes => this.log.debug(`[${d.label}] ignored ${bytes.toString('hex')}`));
    }

    private queryAll(d: Display): void {
        FIELDS.forEach(field => d.client.query(field));
    }

    private async onAnswering(d: Display, answering: boolean): Promise<void> {
        this.log.info(`[${d.label}] ${answering ? 'answering' : 'not answering'}`);
        await this.setState(`${d.id}.info.connection`, { val: answering, ack: true });
        // Over the network a display in standby processes nothing, so silence there is, as far as
        // anyone can tell, a display that is off.
        if (!answering && d.network) {
            await this.setState(`${d.id}.control.power`, { val: false, ack: true });
        }
        const any = [...this.displays.values()].some(x => x.client.answering);
        await this.setState('info.connection', { val: any, ack: true });
    }

    private async onValue(d: Display, field: Field, value: number): Promise<void> {
        let val: ioBroker.StateValue;
        switch (field) {
            case 'power':
                val = d.codec.isPowerOn(value);
                break;
            case 'mute':
                val = value === 1;
                break;
            case 'volume':
                val = value;
                break;
            case 'input':
                d.confirmedInput = value;
                val = formatInput(d.model.protocol, value);
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
    private async fail(d: Display, message: string, field?: Field): Promise<void> {
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
    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            return;
        }
        const rel = id.substring(`${this.namespace}.`.length);
        const separator = rel.indexOf('.');
        const d = separator > 0 ? this.displays.get(rel.substring(0, separator)) : undefined;
        if (!d) {
            return;
        }
        const key = rel.substring(separator + 1);
        await this.setState(`${d.id}.info.lastError`, { val: '', ack: true });

        switch (key) {
            case 'control.power': {
                const on = state.val === true || state.val === 'true' || state.val === 1;
                if (on && d.network && !d.client.answering) {
                    // In standby a display processes nothing over the network: only a magic packet
                    // wakes it. It reports itself on once it is up and the poll reaches it.
                    await this.wakeOnLan(d);
                    break;
                }
                d.client.set('power', d.codec.powerValue(on));
                break;
            }
            case 'control.volume': {
                const level = Math.round(Number(state.val));
                if (!Number.isFinite(level)) {
                    await this.fail(d, `volume: "${String(state.val)}" is not a number`, 'volume');
                    return;
                }
                d.client.set('volume', Math.max(0, Math.min(100, level)));
                break;
            }
            case 'control.mute':
                d.client.set('mute', state.val === true || state.val === 'true' || state.val === 1 ? 1 : 0);
                break;
            case 'control.input': {
                const code = parseInput(d.model.protocol, state.val);
                if (code === undefined || !d.model.inputs.some(i => i.code === code)) {
                    const valid = d.model.inputs.map(i => `${formatInput(d.model.protocol, i.code)} ${i.name}`);
                    await this.fail(
                        d,
                        `input: "${String(state.val)}" is not a ${d.model.name} input (${valid.join(', ')})`,
                        'input',
                    );
                    return;
                }
                // Re-selecting the input already showing is answered only after ~3 s. Compared with
                // what the display last reported: the state already holds the value just written.
                d.client.set('input', code, d.confirmedInput === code ? SAME_INPUT_TIMEOUT_MS : undefined);
                break;
            }
            default:
                this.log.warn(`Unhandled writable state: ${id}`);
        }
    }

    private async wakeOnLan(d: Display): Promise<void> {
        if (!d.mac) {
            this.log.warn(`[${d.label}] cannot switch on over the network without a MAC address (Wake-on-LAN).`);
            return;
        }
        try {
            await wake(d.mac);
            this.log.debug(`[${d.label}] Wake-on-LAN sent`);
        } catch (error) {
            this.log.warn(`[${d.label}] Wake-on-LAN failed: ${(error as Error).message}`);
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback - Callback function
     */
    private onUnload(callback: () => void): void {
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
            this.log.error(`Error during unloading: ${(error as Error).message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Ctouch(options);
} else {
    // otherwise start the instance directly
    (() => new Ctouch())();
}
