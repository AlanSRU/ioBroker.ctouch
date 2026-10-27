import { expect } from 'chai';
import { a9, i3 } from './protocol';
import { KEY_LABELS, MODELS, formatInput, parseInput } from './models';
import jsonConfig from '../../admin/jsonConfig.json';

const hex = (b: Buffer): string => b.toString('hex').toUpperCase();
const bytes = (s: string): Buffer => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('a9 codec (CTOUCH binary)', () => {
    // Every frame below is from the Laser Nova + Laser Sky V4.02 document, or the Centro program
    // that drove the Cap & Thistle display with Set ID 09.
    it('encodes commands as A9 <cmd> <ID> <data> 8A', () => {
        expect(hex(a9.encodeSet('power', a9.powerValue(true), 9))).to.equal('A91109018A');
        expect(hex(a9.encodeSet('power', a9.powerValue(false), 9))).to.equal('A91109008A');
        expect(hex(a9.encodeSet('volume', 50, 9))).to.equal('A91309328A');
        expect(hex(a9.encodeSet('mute', 1, 9))).to.equal('A91409018A');
        expect(hex(a9.encodeSet('input', 0x08, 9))).to.equal('A91509088A');
    });

    it('encodes queries with data AA', () => {
        expect(hex(a9.encodeQuery('power', 9))).to.equal('A91109AA8A');
        expect(hex(a9.encodeQuery('input', 9))).to.equal('A91509AA8A');
    });

    it('decodes an ACK as the value the display reports', () => {
        const { replies, rest } = a9.decode(bytes('A9 41 09 13 32 8A'));
        expect(replies).to.deep.equal([{ kind: 'value', field: 'volume', value: 50 }]);
        expect(rest.length).to.equal(0);
    });

    it('decodes a NAK with its reason', () => {
        expect(a9.decode(bytes('A9 4E 09 15 02 8A')).replies).to.deep.equal([
            { kind: 'nak', field: 'input', reason: 'invalid data' },
        ]);
    });

    it('keeps a partial frame and resynchronises past junk', () => {
        const first = a9.decode(bytes('FF 00 A9 41 09'));
        expect(first.replies).to.deep.equal([]);
        expect(hex(first.rest)).to.equal('A94109');
        expect(first.discarded.map(hex)).to.deep.equal(['FF00']);
        const second = a9.decode(Buffer.concat([first.rest, bytes('11 01 8A A9 41 09 14 00 8A')]));
        expect(second.replies).to.deep.equal([
            { kind: 'value', field: 'power', value: 1 },
            { kind: 'value', field: 'mute', value: 0 },
        ]);
    });

    it('encodes the backlight and remote keys', () => {
        expect(hex(a9.encodeSet('backlight', 0, 9))).to.equal('A91209008A');
        expect(hex(a9.encodeQuery('backlight', 9))).to.equal('A91209AA8A');
        expect(hex(a9.encodeSet('key', MODELS.laserNova.keys.menu, 9))).to.equal('A91609848A');
        expect(a9.decode(bytes('A9 41 09 16 84 8A')).replies).to.deep.equal([
            { kind: 'value', field: 'key', value: 0x84 },
        ]);
        expect(a9.decode(bytes('A9 41 09 12 01 8A')).replies).to.deep.equal([
            { kind: 'value', field: 'backlight', value: 1 },
        ]);
    });

    it('rejects reserved Set IDs', () => {
        expect(a9.checkId(9)).to.equal(undefined);
        expect(a9.checkId(0)).to.be.a('string'); // broadcast: never acknowledged
        expect(a9.checkId(0x8a)).to.be.a('string');
        expect(a9.checkId(0xa9)).to.be.a('string');
    });
});

describe('i3 codec (i3-CONNECT ASCII)', () => {
    // Frames from the Cactus v1.2 / Veneer 2 v1.0 documents (examples use ID 01).
    it('encodes sets and gets', () => {
        expect(hex(i3.encodeSet('volume', 50, 1))).to.equal('3A303153383035300D');
        expect(hex(i3.encodeSet('power', i3.powerValue(true), 1))).to.equal('3A303153303030330D');
        expect(hex(i3.encodeSet('power', i3.powerValue(false), 1))).to.equal('3A303153303030320D');
        expect(hex(i3.encodeSet('input', 21, 1))).to.equal('3A3031533A3032310D');
        expect(hex(i3.encodeQuery('volume', 1))).to.equal('3A303147383030300D');
    });

    it('decodes a get reply as a value, and ACK / NAK lines', () => {
        const { replies } = i3.decode(bytes('3A 30 31 72 38 30 35 30 0D 34 30 31 2B 0D 34 30 31 2D 0D'));
        expect(replies).to.deep.equal([
            { kind: 'value', field: 'volume', value: 50 },
            { kind: 'ack' },
            { kind: 'nak', reason: 'refused' },
        ]);
    });

    it('sets the backlight through the power command, and keys through 0x41', () => {
        // the document's examples: Backlight Off, Backlight On, remote Up
        expect(hex(i3.encodeSet('backlight', 0, 1))).to.equal('3A303153303030300D');
        expect(hex(i3.encodeSet('backlight', 1, 1))).to.equal('3A303153303030310D');
        expect(hex(i3.encodeSet('key', MODELS.cactus.keys.up, 1))).to.equal('3A303153413031300D');
    });

    it('decodes a power reply as power, and reads the backlight from it', () => {
        expect(i3.decode(bytes('3A 30 31 72 30 30 30 30 0D')).replies).to.deep.equal([
            { kind: 'value', field: 'power', value: 0 },
        ]);
        expect(i3.backlightFromPower(0)).to.equal(false);
        expect(i3.backlightFromPower(1)).to.equal(true);
        expect(i3.backlightFromPower(2)).to.equal(undefined);
    });

    it('reads a dark backlight as power on, and power off as off', () => {
        expect(i3.isPowerOn(0)).to.equal(true);
        expect(i3.isPowerOn(1)).to.equal(true);
        expect(i3.isPowerOn(2)).to.equal(false);
    });

    it('keeps a line without CR for the next chunk', () => {
        const { replies, rest } = i3.decode(Buffer.from(':01r80', 'ascii'));
        expect(replies).to.deep.equal([]);
        expect(rest.toString('ascii')).to.equal(':01r80');
    });
});

describe('models', () => {
    it('formats inputs the way each document writes them', () => {
        expect(formatInput('a9', 0x08)).to.equal('08');
        expect(formatInput('a9', 0x14)).to.equal('14');
        expect(formatInput('i3', 21)).to.equal('021');
        expect(parseInput('a9', '0d')).to.equal(0x0d);
        expect(parseInput('i3', '021')).to.equal(21);
        expect(parseInput('a9', 'HDMI')).to.equal(undefined);
    });

    it('keeps the Laser Nova inputs the venue uses', () => {
        const codes = MODELS.laserNova.inputs.map(i => formatInput('a9', i.code));
        expect(codes).to.include.members(['05', '06', '08']);
    });

    it('has a label for every key, and no duplicate key codes within a model', () => {
        for (const [id, model] of Object.entries(MODELS)) {
            Object.keys(model.keys).forEach(k => expect(KEY_LABELS, `${id} ${k}`).to.have.property(k));
            const codes = Object.values(model.keys);
            expect(new Set(codes).size, id).to.equal(codes.length);
        }
    });

    it("lists every model's keys on the admin page, as models.ts has them", () => {
        const items = Object.values(jsonConfig.items as Record<string, { text?: string }>);
        for (const model of Object.values(MODELS)) {
            const short = model.name.replace(/^(CTOUCH|i3-CONNECT) /, '');
            const line = items.find(i => i.text?.split(': ')[0].split(', ').includes(short));
            expect(line?.text?.split(': ')[1], model.name).to.equal(Object.keys(model.keys).join(', '));
        }
    });

    it('has no duplicate input codes within a model', () => {
        for (const [id, model] of Object.entries(MODELS)) {
            const codes = model.inputs.map(i => i.code);
            expect(new Set(codes).size, id).to.equal(codes.length);
        }
    });
});
