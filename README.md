![Logo](admin/ctouch.png)
# ioBroker.ctouch

[![NPM version](https://img.shields.io/npm/v/iobroker.ctouch.svg)](https://www.npmjs.com/package/iobroker.ctouch)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ctouch.svg)](https://www.npmjs.com/package/iobroker.ctouch)
![Number of Installations](https://iobroker.live/badges/ctouch-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ctouch-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.ctouch.png?downloads=true)](https://nodei.co/npm/iobroker.ctouch/)

**Tests:** ![Test and Release](https://github.com/AlanSRU/ioBroker.ctouch/workflows/Test%20and%20Release/badge.svg)

## CTOUCH / i3-CONNECT adapter for ioBroker

Controls CTOUCH and i3-CONNECT interactive displays over their RS-232 protocols: **power, volume,
mute and input**. A display can be reached through a serial-to-Ethernet converter on its RS-232 port,
or directly on its own network port.

Every value comes from the display. A write is acknowledged only when the display confirms it, and
the four controls are read back every poll interval, so a change made with the display's own remote
or buttons shows up too.

### Supported models

| Model | Protocol | Factory baud | Network port |
|---|---|---|---|
| CTOUCH Laser Nova | CTOUCH binary | 9600 | TCP 5000 |
| CTOUCH Laser Sky | CTOUCH binary | 9600 | TCP 5000 |
| CTOUCH Riva R2 | CTOUCH binary | 9600 | TCP 5000 |
| CTOUCH Neo | CTOUCH binary | 115200 | — |
| i3-CONNECT Cactus | i3-CONNECT ASCII | 9600 | TCP 4664 |
| i3-CONNECT Veneer 2 | i3-CONNECT ASCII | 9600 | TCP 4664 |

Each model has its own input list, taken from its manufacturer document. Input codes are not shared
between models: `0D` is Android on a Laser Nova but HDMI 4 on a Laser Sky.

The i3-CONNECT **Walnut W1** uses a different protocol (checksummed frames over UDP 8600) and is not
supported yet.

Tested on hardware: Laser Nova (via a serial converter). The other models are implemented from
their documents and tested against a simulator; reports from owners are welcome.

### Configuration

One row per display:

| Column | Meaning |
|---|---|
| Model | which input list and protocol to use |
| Connection | **Serial converter**: an RS-232-to-Ethernet converter in TCP server mode on the display's RS-232 port. **Display network port**: the display's own RS-232-over-IP port |
| IP address / Port | of the converter, or of the display. Port 0 with a network connection means the model's documented port |
| Set ID | must match the ID set in the display's menu (1-255; 0 broadcasts and is never answered) |
| MAC address | only for switching a display on over the network (Wake-on-LAN) |

**Serial converter:** set its serial side to the display's baud rate (above), 8 data bits, no
parity, 1 stop bit. On the display's DB9: pin 2 TxD, pin 3 RxD, pin 5 GND.

**Display network port:** in standby a display ignores network commands, so it is switched on by
Wake-on-LAN (enable it in the display's settings and enter its MAC address). While it does not
answer, the adapter reports it as off.

### States

Per display, in `ctouch.0.<name>`:

| State | Type | |
|---|---|---|
| `control.power` | boolean | writable |
| `control.volume` | number 0-100 | writable |
| `control.mute` | boolean | writable |
| `control.input` | string | writable; the display's input code, e.g. `05` (HDMI 1) on a Laser Nova, `001` on a Cactus. The allowed values are listed in the object |
| `info.connection` | boolean | the display is answering |
| `info.lastError` | string | why the last write did not complete (refused, no reply, invalid input) |
| `info.model` | string | configured model |

`ctouch.0.info.connection` is true while any display answers.

### Protocol notes

- One request at a time; a request with no reply within 500 ms is retried once.
- Re-selecting the input that is already showing is answered only after about 3 s; the adapter
  waits for it instead of retrying.
- The displays never report a change by themselves, hence the poll (default every 30 s).

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Alan Paris) Initial release: CTOUCH Laser Nova, Laser Sky, Riva R2, Neo and i3-CONNECT Cactus, Veneer 2; power, volume, mute and input, confirmed by the display

## License
MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.