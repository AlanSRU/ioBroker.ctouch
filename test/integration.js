const path = require('path');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

// the simulator is TypeScript and not part of the build
require('ts-node').register({ transpileOnly: true, project: path.join(__dirname, '../tsconfig.json') });
const { DisplaySimulator } = require('./lib/simulator');

const NS = 'ctouch.0';

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Two simulated displays, one per protocol family', getHarness => {
            let harness;
            let nova;
            let cactus;

            const getState = id =>
                new Promise((resolve, reject) =>
                    harness.states.getState(`${NS}.${id}`, (err, state) => (err ? reject(err) : resolve(state))),
                );
            const setState = (id, val) =>
                new Promise((resolve, reject) =>
                    harness.states.setState(`${NS}.${id}`, { val, ack: false }, err => (err ? reject(err) : resolve())),
                );
            /** Wait until a state has been acknowledged with a value matching the predicate. */
            const waitFor = async (id, predicate, timeoutMs = 8000) => {
                const end = Date.now() + timeoutMs;
                let state;
                while (Date.now() < end) {
                    state = await getState(id);
                    if (state && state.ack && predicate(state.val)) {
                        return state.val;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                throw new Error(`${id} is ${JSON.stringify(state && state.val)} after ${timeoutMs} ms`);
            };

            before(async function () {
                this.timeout(60000);
                harness = getHarness();
                nova = new DisplaySimulator({
                    protocol: 'a9',
                    id: 9,
                    inputs: [0x05, 0x06, 0x08],
                    sameInputDelayMs: 1000,
                });
                cactus = new DisplaySimulator({ protocol: 'i3', id: 1, inputs: [1, 2, 21, 22, 101] });
                const novaPort = await nova.listen();
                const cactusPort = await cactus.listen();
                await harness.changeAdapterConfig('ctouch', {
                    native: {
                        devices: [
                            {
                                enabled: true,
                                name: 'Cap Thistle',
                                model: 'laserNova',
                                connection: 'converter',
                                host: '127.0.0.1',
                                port: novaPort,
                                displayId: 9,
                            },
                            {
                                enabled: true,
                                name: 'Meeting Room',
                                model: 'cactus',
                                connection: 'network',
                                host: '127.0.0.1',
                                port: cactusPort,
                                displayId: 1,
                            },
                        ],
                        pollInterval: 5,
                    },
                });
                await harness.startAdapterAndWait(true);
            });

            after(async () => {
                await nova?.close();
                await cactus?.close();
            });

            it('reads both displays on connect', async function () {
                this.timeout(20000);
                expect(await waitFor('cap_thistle.info.connection', v => v === true)).to.equal(true);
                expect(await waitFor('cap_thistle.control.volume', v => v === 20)).to.equal(20);
                expect(await waitFor('cap_thistle.control.input', v => v === '05')).to.equal('05');
                expect(await waitFor('meeting_room.control.input', v => v === '001')).to.equal('001');
                expect(await waitFor('info.connection', v => v === true)).to.equal(true);
            });

            it('acknowledges a write only with what the display confirmed', async function () {
                this.timeout(20000);
                await setState('cap_thistle.control.power', true);
                expect(await waitFor('cap_thistle.control.power', v => v === true)).to.equal(true);
                expect(nova.state.power).to.equal(true);

                await setState('cap_thistle.control.input', '08');
                expect(await waitFor('cap_thistle.control.input', v => v === '08')).to.equal('08');
                expect(nova.state.input).to.equal(0x08);

                await setState('meeting_room.control.volume', 40);
                expect(await waitFor('meeting_room.control.volume', v => v === 40)).to.equal(40);
                expect(cactus.state.volume).to.equal(40);
            });

            it('waits for the slow reply when re-selecting the current input', async function () {
                this.timeout(20000);
                await setState('cap_thistle.control.input', '08');
                expect(await waitFor('cap_thistle.control.input', v => v === '08')).to.equal('08');
                expect((await getState('cap_thistle.info.lastError')).val).to.equal('');
            });

            it('rejects an input the model does not have, and keeps the real one', async function () {
                this.timeout(20000);
                await setState('cap_thistle.control.input', '99');
                expect(
                    await waitFor('cap_thistle.info.lastError', v => /not a CTOUCH Laser Nova input/.test(v)),
                ).to.be.a('string');
                expect(await waitFor('cap_thistle.control.input', v => v === '08')).to.equal('08');
            });

            it('switches the backlight on both families', async function () {
                this.timeout(20000);
                await setState('cap_thistle.control.backlight', false);
                expect(await waitFor('cap_thistle.control.backlight', v => v === false)).to.equal(false);
                expect(nova.state.backlight).to.equal(false);

                // i3: set through the power command, read back from the power reply at the next poll
                cactus.state.power = true;
                await setState('meeting_room.control.backlight', false);
                expect(await waitFor('meeting_room.control.backlight', v => v === false)).to.equal(false);
                expect(cactus.state.backlight).to.equal(false);
                cactus.state.backlight = true;
                expect(await waitFor('meeting_room.control.backlight', v => v === true, 12000)).to.equal(true);
                expect(await waitFor('meeting_room.control.power', v => v === true)).to.equal(true);
            });

            it('sends a remote key and acknowledges it, and rejects one the model lacks', async function () {
                this.timeout(20000);
                await setState('cap_thistle.control.key', 'menu');
                expect(await waitFor('cap_thistle.control.key', v => v === 'menu')).to.equal('menu');
                expect(nova.keys).to.deep.equal([0x84]);

                await setState('meeting_room.control.key', 'up');
                expect(await waitFor('meeting_room.control.key', v => v === 'up')).to.equal('up');
                expect(cactus.keys).to.deep.equal([10]);

                await setState('meeting_room.control.key', 'screenshot');
                expect(
                    await waitFor('meeting_room.info.lastError', v => /not a i3-CONNECT Cactus key/.test(v)),
                ).to.be.a('string');
                expect(cactus.keys).to.deep.equal([10]);
            });

            it('reads volume and mute back straight after their keys', async function () {
                this.timeout(20000);
                // well inside the 5 s poll, so only the read-back can deliver it
                const volume = cactus.state.volume;
                await setState('meeting_room.control.key', 'volumeUp');
                expect(await waitFor('meeting_room.control.volume', v => v === volume + 1, 1500)).to.equal(volume + 1);
                const muted = nova.state.mute;
                await setState('cap_thistle.control.key', 'mute');
                expect(await waitFor('cap_thistle.control.mute', v => v === !muted, 1500)).to.equal(!muted);
            });

            it('picks up a change made on the display itself at the next poll', async function () {
                this.timeout(20000);
                nova.state.volume = 33;
                expect(await waitFor('cap_thistle.control.volume', v => v === 33, 12000)).to.equal(33);
            });
        });
    },
});
