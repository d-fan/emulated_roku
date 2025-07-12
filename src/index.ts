// Emulated Roku – idiomatic TypeScript implementation
// ----------------------------------------------------
// This single‑file library re‑implements the behaviour of martonperei/emulated_roku
// using Node.js, Express, and node-ssdp – all of which ship with TypeScript types.
//
// • Express powers the HTTP server that replicates Roku’s ECP endpoints.
// • node‑ssdp advertises/discovers the device via SSDP/UPnP multicast (same
//   protocol Roku boxes use).
// • ipaddr.js gives us reliable IPv4 private‑network checks.
// • Built‑in crypto is used to generate a stable UUID from the device USN.
//
// ----------------------------------------------------
// External deps (install with npm i):
//   express, node-ssdp, ipaddr.js
//   @types/express, @types/node-ssdp, @types/ipaddr.js (if using npm < v20)
// ----------------------------------------------------

import express from 'express';
import { Server as HttpServer } from 'http';
import { networkInterfaces } from 'os';
import crypto from 'crypto';
import { Server as SsdpServer } from 'node-ssdp';
import ipaddr from 'ipaddr.js';

/* -------------------------------------------------------------------------
 * Constants & XML templates – kept close to the originals for parity.
 * -------------------------------------------------------------------------*/
const MULTICAST_TTL = 300;

// Base64‑1 × 1 placeholder PNG (identical to Python version)
const APP_PLACEHOLDER_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=',
  'base64',
);

const INFO_TEMPLATE = (
  uuid: string,
  usn: string,
) => `<?xml version="1.0" encoding="UTF-8" ?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:roku-com:device:player:1-0</deviceType>
    <friendlyName>${usn}</friendlyName>
    <manufacturer>Roku</manufacturer>
    <manufacturerURL>http://www.roku.com/</manufacturerURL>
    <modelDescription>Emulated Roku</modelDescription>
    <modelName>Roku 4</modelName>
    <modelNumber>4400x</modelNumber>
    <modelURL>http://www.roku.com/</modelURL>
    <serialNumber>${usn}</serialNumber>
    <UDN>uuid:${uuid}</UDN>
  </device>
</root>`;

const DEVICE_INFO_TEMPLATE = (uuid: string, usn: string) => `<device-info>
  <udn>${uuid}</udn>
  <serial-number>${usn}</serial-number>
  <device-id>${usn}</device-id>
  <vendor-name>Roku</vendor-name>
  <model-number>4400X</model-number>
  <model-name>Roku 4</model-name>
  <model-region>US</model-region>
  <supports-ethernet>true</supports-ethernet>
  <wifi-mac>00:00:00:00:00:00</wifi-mac>
  <ethernet-mac>00:00:00:00:00:00</ethernet-mac>
  <network-type>ethernet</network-type>
  <user-device-name>${usn}</user-device-name>
  <software-version>7.5.0</software-version>
  <software-build>09021</software-build>
  <secure-device>true</secure-device>
  <language>en</language>
  <country>US</country>
  <locale>en_US</locale>
  <time-zone>US/Pacific</time-zone>
  <time-zone-offset>-480</time-zone-offset>
  <power-mode>PowerOn</power-mode>
  <supports-suspend>false</supports-suspend>
  <supports-find-remote>false</supports-find-remote>
  <supports-audio-guide>false</supports-audio-guide>
  <developer-enabled>false</developer-enabled>
  <keyed-developer-id>0000000000000000000000000000000000000000</keyed-developer-id>
  <search-enabled>false</search-enabled>
  <voice-search-enabled>false</voice-search-enabled>
  <notifications-enabled>false</notifications-enabled>
  <notifications-first-use>false</notifications-first-use>
  <supports-private-listening>false</supports-private-listening>
  <headphones-connected>false</headphones-connected>
</device-info>`;

const APPS_TEMPLATE = `<apps>
  ${Array.from({ length: 10 }, (_, idx) => `<app id="${idx + 1}" version="1.0.0">Emulated App ${idx + 1}</app>`).join('\n  ')}
</apps>`;

const ACTIVE_APP_TEMPLATE = `<active-app>\n  <app>Roku</app>\n</active-app>`;

/* -------------------------------------------------------------------------
 * Supporting types & helpers
 * -------------------------------------------------------------------------*/
export enum RokuKey {
  Home = 'Home',
  Rev = 'Rev',
  Fwd = 'Fwd',
  Play = 'Play',
  Select = 'Select',
  Left = 'Left',
  Right = 'Right',
  Down = 'Down',
  Up = 'Up',
  Back = 'Back',
  InstantReplay = 'InstantReplay',
  Info = 'Info',
  Backspace = 'Backspace',
  Search = 'Search',
  Enter = 'Enter',
  FindRemote = 'FindRemote',
  VolumeDown = 'VolumeDown',
  VolumeMute = 'VolumeMute',
  VolumeUp = 'VolumeUp',
  PowerOff = 'PowerOff',
  ChannelUp = 'ChannelUp',
  ChannelDown = 'ChannelDown',
  InputTuner = 'InputTuner',
  InputHDMI1 = 'InputHDMI1',
  InputHDMI2 = 'InputHDMI2',
  InputHDMI3 = 'InputHDMI3',
  InputHDMI4 = 'InputHDMI4',
  InputAV1 = 'InputAV1',
}

export interface RokuCommandHandler {
  onKeyDown(usn: string, key: RokuKey | string): void;
  onKeyUp(usn: string, key: RokuKey | string): void;
  onKeyPress(usn: string, key: RokuKey | string): void;
  launch(usn: string, appId: string): void;
}

export interface EmulatedRokuOptions {
  /** Unique Roku USN (serial) */
  usn: string;
  /** Local interface IP to bind (default: auto‑detect first non‑loopback) */
  hostIp?: string;
  /** HTTP port to listen on (default 8060 like real Roku) */
  listenPort?: number;
  /** IP address to advertise over SSDP (default: hostIp) */
  advertiseIp?: string;
  /** Port to advertise over SSDP (default: listenPort) */
  advertisePort?: number;
  /** Provide custom handler hooks */
  handler?: RokuCommandHandler;
  /** Disable multicast binding (Windows default) */
  bindMulticast?: boolean;
}

/** Return the first private IPv4 address on the machine (fallback 127.0.0.1) */
function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const [, infos] of Object.entries(nets)) {
    if (!infos) continue;
    for (const ni of infos) {
      if (ni.family === 'IPv4' && !ni.internal) {
        return ni.address;
      }
    }
  }
  return '127.0.0.1';
}

/* -------------------------------------------------------------------------
 * Emulated Roku class
 * -------------------------------------------------------------------------*/
export class EmulatedRoku {
  private readonly app = express();
  private http?: HttpServer;
  private ssdp?: SsdpServer;
  private readonly usn: string;
  private readonly uuid: string;
  private readonly hostIp: string;
  private readonly listenPort: number;
  private readonly advertiseIp: string;
  private readonly advertisePort: number;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly handler: RokuCommandHandler;
  private readonly bindMulticast: boolean;

  constructor(opts: EmulatedRokuOptions) {
    this.usn = opts.usn;
    this.uuid = crypto.createHash('sha1').update(opts.usn).digest('hex');

    this.hostIp = opts.hostIp ?? getLocalIp();
    this.listenPort = opts.listenPort ?? 8060;
    this.advertiseIp = opts.advertiseIp ?? this.hostIp;
    this.advertisePort = opts.advertisePort ?? this.listenPort;
    this.bindMulticast = opts.bindMulticast ?? process.platform !== 'win32';

    this.allowedHosts = new Set([
      this.hostIp,
      `${this.hostIp}:${this.listenPort}`,
      this.advertiseIp,
      `${this.advertiseIp}:${this.advertisePort}`,
    ]);

    this.handler = opts.handler ?? {
      onKeyDown: () => {},
      onKeyUp: () => {},
      onKeyPress: () => {},
      launch: () => {},
    };

    this.configureMiddleware();
    this.configureRoutes();
  }

  /* --------------------------- public API --------------------------- */
  async start(): Promise<void> {
    // 1) Start HTTP server
    await new Promise<void>((resolve) => {
      this.http = this.app.listen(this.listenPort, this.hostIp, () =>
        resolve(),
      );
    });

    // 2) Start SSDP advertising
    this.ssdp = new SsdpServer({
      explicitSocketBind: this.bindMulticast,
      location: `http://${this.advertiseIp}:${this.advertisePort}/`,
      ttl: MULTICAST_TTL,
      udn: `uuid:roku:ecp:${this.usn}`,
    });

    // Answer to search requests for roku:ecp or upnp:rootdevice
    this.ssdp.addUSN('roku:ecp');

    // node-ssdp exposes a .start() returning void but we wrap in promise for order
    await new Promise<void>((resolve) => this.ssdp!.start(() => resolve()));

    console.info(
      `Emulated Roku started at http://${this.hostIp}:${this.listenPort} (USN: ${this.usn})`,
    );
  }

  async stop(): Promise<void> {
    this.ssdp?.stop();
    await new Promise<void>((resolve, reject) => {
      if (!this.http) return resolve();
      this.http.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /* ------------------------- internals ----------------------------- */
  private configureMiddleware(): void {
    this.app.use(express.text({ type: '*/*' })); // Roku sends plain text bodies

    // Host & remote‑IP security (equiv. to Python version)
    this.app.use((req, res, next) => {
      if (
        req.headers.host == null ||
        !this.allowedHosts.has(req.headers.host)
      ) {
        res.status(403).send('Forbidden - Host not allowed');
      }
      if (req.ip == null) {
        res.status(403).send('Forbidden - No remote IP');
        return;
      }
      const remote = req.ip.replace('::ffff:', '');
      if (
        !ipaddr.isValid(remote) ||
        ipaddr.parse(remote).range()?.startsWith('private') !== true
      ) {
        res.status(403).send('Forbidden - Non-local network');
      }
      next();
    });
  }

  private configureRoutes(): void {
    /* Root & device‑info */
    this.app.get('/', (_req, res) => {
      res.type('text/xml').send(INFO_TEMPLATE(this.uuid, this.usn));
    });
    this.app.get('/query/device-info', (_req, res) => {
      res.type('text/xml').send(DEVICE_INFO_TEMPLATE(this.uuid, this.usn));
    });

    /* Apps & icons */
    this.app.get('/query/apps', (_req, res) => {
      res.type('text/xml').send(APPS_TEMPLATE);
    });
    this.app.get('/query/icon/:id', (_req, res) => {
      res.type('image/png').send(APP_PLACEHOLDER_ICON);
    });
    this.app.get('/query/active-app', (_req, res) => {
      res.type('text/xml').send(ACTIVE_APP_TEMPLATE);
    });

    /* Search & input (no‑op) */
    this.app.post('/input', (_req, res) => {
      res.sendStatus(200);
    });
    this.app.post('/search', (_req, res) => {
      res.sendStatus(200);
    });

    /* Key events */
    this.app.post('/keydown/:key', (req, res) => {
      this.handler.onKeyDown(this.usn, req.params.key);
      res.sendStatus(200);
    });
    this.app.post('/keyup/:key', (req, res) => {
      this.handler.onKeyUp(this.usn, req.params.key);
      res.sendStatus(200);
    });
    this.app.post('/keypress/:key', (req, res) => {
      this.handler.onKeyPress(this.usn, req.params.key);
      res.sendStatus(200);
    });

    /* Launch */
    this.app.post('/launch/:id', (req, res) => {
      this.handler.launch(this.usn, req.params.id);
      res.sendStatus(200);
    });
  }
}

/* -------------------------------------------------------------------------
 * Example usage (remove when bundling as library)
 * -------------------------------------------------------------------------*/
if (require.main === module) {
  const roku = new EmulatedRoku({ usn: '0123456789AB' });
  roku.start();

  // Graceful shutdown
  process.on('SIGINT', () => roku.stop().finally(() => process.exit()));
}
