import { expect } from 'chai';
import { DisplayClient, type ClientEvents } from './client';
import { CODECS, type Field, type ProtocolName } from './protocol';
import { DisplaySimulator } from '../../test/lib/simulator';

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A client against a simulator, recording every event.
 *
 * @param protocol - protocol family
 * @param inputs - input codes the simulated display accepts
 */
async function rig(
    protocol: ProtocolName,
    inputs: number[],
): Promise<{
    sim: DisplaySimulator;
    client: DisplayClient;
    events: string[];
    values: Partial<Record<Field, number>>;
}> {
    const id = protocol === 'a9' ? 9 : 1;
    const sim = new DisplaySimulator({ protocol, id, inputs, sameInputDelayMs: 600 });
    const port = await sim.listen();
    const client = new DisplayClient({
        host: '127.0.0.1',
        port,
        codec: CODECS[protocol],
        id,
        replyTimeoutMs: 150,
        reconnectMs: 100,
    });
    const events: string[] = [];
    const values: Partial<Record<Field, number>> = {};
    const record =
        <K extends keyof ClientEvents>(name: K) =>
        (...args: ClientEvents[K]): void => {
            events.push(`${name} ${args.map(a => (Buffer.isBuffer(a) ? a.toString('hex') : String(a))).join(' ')}`);
        };
    (['refused', 'noReply', 'notSent', 'link', 'answering'] as const).forEach(name => client.on(name, record(name)));
    client.on('value', (field, value) => {
        values[field] = value;
        events.push(`value ${field} ${value}`);
    });
    client.start();
    await wait(50);
    return { sim, client, events, values };
}

for (const protocol of ['a9', 'i3'] as const) {
    const inputs = protocol === 'a9' ? [0x05, 0x06, 0x08] : [1, 2, 21];
    const [, hdmi2, hdmi3] = inputs;
    const powerOn = CODECS[protocol].powerValue(true);

    describe(`DisplayClient (${protocol})`, function () {
        this.timeout(5000);
        let r: Awaited<ReturnType<typeof rig>>;
        beforeEach(async () => {
            r = await rig(protocol, inputs);
        });
        afterEach(async () => {
            r.client.stop();
            await r.sim.close();
        });

        it('reads the display, and reports it answering', async () => {
            (['power', 'volume', 'mute', 'input'] as const).forEach(f => r.client.query(f));
            await wait(150);
            expect(r.values.volume).to.equal(20);
            expect(r.values.input).to.equal(inputs[0]);
            expect(r.client.answering).to.equal(true);
        });

        it('confirms a set only through the display', async () => {
            r.client.set('power', powerOn);
            await wait(100);
            expect(r.sim.state.power).to.equal(true);
            expect(r.values.power).to.equal(powerOn);
        });

        it('sends one request at a time and collapses a dragged slider', async () => {
            r.client.set('volume', 30);
            r.client.set('volume', 45);
            r.client.set('volume', 60);
            await wait(200);
            expect(r.sim.state.volume).to.equal(60);
            expect(r.sim.received.length).to.equal(2); // 30 (already in flight), then only 60
            expect(r.values.volume).to.equal(60);
        });

        it('switches the backlight, confirmed by the display', async () => {
            r.client.set('backlight', 0);
            await wait(100);
            expect(r.sim.state.backlight).to.equal(false);
            expect(r.values.backlight).to.equal(0);
        });

        it('sends every key press, without collapsing repeats', async () => {
            const down = protocol === 'a9' ? 0xd8 : 11;
            r.client.set('key', down);
            r.client.set('key', down);
            r.client.set('key', down);
            await wait(200);
            expect(r.sim.keys).to.deep.equal([down, down, down]);
            expect(r.values.key).to.equal(down);
        });

        it('retries once when the display is busy', async () => {
            r.sim.busy = 1;
            r.client.set('mute', 1);
            await wait(400);
            expect(r.sim.received.length).to.equal(2);
            expect(r.values.mute).to.equal(1);
        });

        it('reports a refused value and keeps it unconfirmed', async () => {
            r.client.set('input', 0x55);
            await wait(100);
            expect(r.events.some(e => e.startsWith('refused input'))).to.equal(true);
            expect(r.values.input).to.equal(undefined);
        });

        it('waits longer when re-selecting the input already showing', async () => {
            r.client.set('input', hdmi3);
            await wait(100);
            r.client.set('input', hdmi3, 1000);
            await wait(300);
            expect(r.sim.received.length).to.equal(2); // no retry inside the long timeout
            await wait(500);
            expect(r.values.input).to.equal(hdmi3);
            expect(r.events.filter(e => e.startsWith('noReply'))).to.deep.equal([]);
        });

        it('reports a set that got no reply at all', async () => {
            r.sim.silent = true;
            r.client.set('input', hdmi2);
            await wait(450);
            expect(r.events).to.include('noReply input');
        });

        it('stops counting the display as answering after unanswered queries', async () => {
            r.client.query('power');
            await wait(100);
            expect(r.client.answering).to.equal(true);
            r.sim.silent = true;
            for (let i = 0; i < 8; i++) {
                r.client.query((['power', 'volume', 'mute', 'input'] as const)[i % 4]);
                await wait(320);
            }
            expect(r.client.answering).to.equal(false);
        }).timeout(10000);

        it('reconnects after the link drops, and reports sets it could not send', async () => {
            r.sim.dropConnections();
            await wait(20);
            r.client.set('volume', 10);
            expect(r.events).to.include('notSent volume not connected');
            await wait(250);
            expect(r.client.connected).to.equal(true);
            r.client.set('volume', 10);
            await wait(100);
            expect(r.values.volume).to.equal(10);
        });
    });
}
