import dgram from 'dgram';
import os from 'os';
import { networkInterfaces } from 'os';
import { Server } from 'http';
import express from 'express';
import { Logger } from 'winston';
import { v5 as uuid5 } from 'uuid';

const log = new Logger();

export const APP_PLACEHOLDER_ICON = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBgDTD2qgAAAAASUVORK5CYII=",
  "base64"
);

const formatInfoTemplate = ({ uuid, usn }: { uuid: string, usn: string }) => `<?xml version="1.0" encoding="UTF-8" ?>
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
</root>
`;

const formatDeviceInfoTemplate = ({
  uuid,
  usn
}: {
  uuid: string;
  usn: string;
}) => `<device-info>
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
</device-info>
`;

export const APPS_TEMPLATE = `<apps>
  <app id="1" version="1.0.0">Emulated App 1</app>
  <app id="2" version="1.0.0">Emulated App 2</app>
  <app id="3" version="1.0.0">Emulated App 3</app>
  <app id="4" version="1.0.0">Emulated App 4</app>
  <app id="5" version="1.0.0">Emulated App 5</app>
  <app id="6" version="1.0.0">Emulated App 6</app>
  <app id="7" version="1.0.0">Emulated App 7</app>
  <app id="8" version="1.0.0">Emulated App 8</app>
  <app id="9" version="1.0.0">Emulated App 9</app>
  <app id="10" version="1.0.0">Emulated App 10</app>
</apps>
`;

export const ACTIVE_APP_TEMPLATE = `<active-app>
  <app>Roku</app>
</active-app>
`;

// Multicast/SSDP constants
const MULTICAST_TTL = 300;
const MULTICAST_TTL_MS = MULTICAST_TTL * 1000;
const MULTICAST_MAX_DELAY = 5;
const MULTICAST_GROUP = "239.255.255.250";
const MULTICAST_PORT = 1900;

/**
 * Roku SSDP Discovery protocol.
 */
export class EmulatedRokuDiscoveryProtocol {
  private ssdpResponse: string;
  private notifyBroadcast: Buffer;

  constructor(
    public hostIp: string,
    public rokuUsn: string,
    public advertiseIp: string,
    public advertisePort: number,
    private dgramSocket: dgram.Socket
  ) {
    this.ssdpResponse = `HTTP/1.1 200 OK
      Cache-Control: max-age = ${MULTICAST_TTL}
      ST: roku:ecp
      SERVER: Roku/12.0.0 UPnP/1.0 Roku/12.0.0
      Ext: 
      Location: http://${this.advertiseIp}:${this.advertisePort}/
      USN: uuid:roku:ecp:${this.rokuUsn}
    `;
    this.notifyBroadcast = Buffer.from(`NOTIFY * HTTP/1.1
      HOST: ${MULTICAST_GROUP}:${MULTICAST_PORT}
      Cache-Control: max-age = ${MULTICAST_TTL}
      NT: upnp:rootdevice
      NTS: ssdp:alive
      Location: http://${this.advertiseIp}:${this.advertisePort}/
      USN: uuid:roku:ecp:{usn}
    `);

    this.dgramSocket.on('message', this.datagramReceived.bind(this));
    this.dgramSocket.on('listening', this.connectionMade.bind(this));
    this.dgramSocket.on('close', this.connectionLost.bind(this));
    this.dgramSocket.bind(MULTICAST_PORT, this.hostIp, () => {
      console.debug(`SSDP Discovery Protocol bound to ${this.hostIp}:${MULTICAST_PORT}`);
    });
  }

  private notifyInterval?: NodeJS.Timeout;
  private connected = false;

  /**
   * Set up the multicast socket and schedule the NOTIFY message.
   */
  connectionMade() {
    log.debug("multicast:started", {
      multicastGroup: MULTICAST_GROUP,
      advertiseIp: this.advertiseIp,
      advertisePort: this.advertisePort,
      rokuUsn: this.rokuUsn
    })

    // Clear any existing interval
    if (this.notifyInterval) {
      clearInterval(this.notifyInterval);
    }

    this.connected = true;

    // Immediately send the first NOTIFY
    this.multicastNotify();

    // Schedule repeated NOTIFY broadcasts
    this.notifyInterval = setInterval(this.multicastNotify.bind(this), MULTICAST_TTL_MS);
  }

  /**
   * Clean up the protocol.
   */
  connectionLost() {
    log.debug("multicast:connection_lost", {
      advertiseIp: this.advertiseIp,
      advertisePort: this.advertisePort,
      rokuUsn: this.rokuUsn
    });
    this.close();
  }

  /**
   * Broadcast a NOTIFY multicast message.
   */
  private multicastNotify() {
    log.debug("multicast:broadcast", { notifyBroadcast: this.notifyBroadcast });
    this.dgramSocket.send(
      this.notifyBroadcast,
      0,
      this.notifyBroadcast.byteLength,
      MULTICAST_PORT,
      MULTICAST_GROUP
    );
  }

  /**
   * Parse the received datagram and send a reply if needed.
   */
  datagramReceived(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const data = msg.toString('utf-8').trim();
    const addr = rinfo.address;

    if (!data.startsWith("M-SEARCH * HTTP/1.1") ||
      !(data.includes("ST: ssdp:all") || data.includes("ST: roku:ecp"))) {
      return;
    }
    log.debug("multicast:request", { data, addr });

    const mxValue = data.indexOf("MX:");

    let delay: number;
    if (mxValue !== -1) {
      const mxDelay = parseInt(data[mxValue + 4], 10) % (MULTICAST_MAX_DELAY + 1);
      delay = Math.random() * (mxDelay + 1) * 1000;
    } else {
      delay = Math.random() * (MULTICAST_MAX_DELAY + 1) * 1000;
    }

    // Reply to a discovery message.
    setTimeout(() => {
      if (!this.connected) {
        return;
      }
      this.dgramSocket.send(
        this.ssdpResponse,
        0,
        this.ssdpResponse.length,
        rinfo.port,
        rinfo.address
      );
    }, delay);
  }

  private close() {
    this.connected = false;
    if (this.notifyInterval) {
      clearInterval(this.notifyInterval);
      this.notifyInterval = undefined;
    }
    this.dgramSocket.close();
  }
}

/**
 * Base handler class for Roku commands.
 */
export class EmulatedRokuCommandHandler {
    KEY_HOME = 'Home'
    KEY_REV = 'Rev'
    KEY_FWD = 'Fwd'
    KEY_PLAY = 'Play'
    KEY_SELECT = 'Select'
    KEY_LEFT = 'Left'
    KEY_RIGHT = 'Right'
    KEY_DOWN = 'Down'
    KEY_UP = 'Up'
    KEY_BACK = 'Back'
    KEY_INSTANTREPLAY = 'InstantReplay'
    KEY_INFO = 'Info'
    KEY_BACKSPACE = 'Backspace'
    KEY_SEARCH = 'Search'
    KEY_ENTER = 'Enter'
    KEY_FINDREMOTE = 'FindRemote'
    KEY_VOLUMEDOWN = 'VolumeDown'
    KEY_VOLUMEMUTE = 'VolumeMute'
    KEY_VOLUMEUP = 'VolumeUp'
    KEY_POWEROFF = 'PowerOff'
    KEY_CHANNELUP = 'ChannelUp'
    KEY_CHANNELDOWN = 'ChannelDown'
    KEY_INPUTTUNER = 'InputTuner'
    KEY_INPUTHDMI1 = 'InputHDMI1'
    KEY_INPUTHDMI2 = 'InputHDMI2'
    KEY_INPUTHDMI3 = 'InputHDMI3'
    KEY_INPUTHDMI4 = 'InputHDMI4'
    KEY_INPUTAV1 = 'InputAV1'

    /**
     * Handle key down command.
     */
    onKeydown(rokuUsn: string, key: string): undefined {}

        /**
         * Handle key up command.
         */
    onKeyup(rokuUsn: string, key: string): undefined {}

        /**
         * Handle key press command.
         */
    onKeypress(rokuUsn: string, key: string): undefined {}

        /**
         * Handle launch command.
         */
    launch(rokuUsn: string, appId: string): undefined {}
}

/**
 * Emulated Roku server.
 *
 * Handles the API HTTP server and UPNP discovery.
 */
export class EmulatedRokuServer {
  private allowed_hosts: string[];
  private roku_uuid: string;
  private roku_info: string;
  private device_info: string;
  private discovery_proto: EmulatedRokuDiscoveryProtocol | null;
  private api_runner: web.AppRunner | null;

  /**
   * Initialize the Roku API server.
   */
    constructor(
      public handler: EmulatedRokuCommandHandler,
      public rokuUsn: string,
      public hostIp: string,
      public listenPort: number,
      public advertiseIp: string | null = null,
      public advertisePort: number | null = null,
      public bindMulticast: boolean | null = null)
    {
        this.advertiseIp = advertiseIp ?? hostIp
        this.advertisePort = advertisePort ?? listenPort

        this.allowed_hosts = [
            this.hostIp,
            `${this.hostIp}:${this.listenPort}`,
            this.advertiseIp,
            `${this.advertiseIp}:${this.advertisePort}`,
        ]

        if (bindMulticast === null) {
            // do not bind multicast group on windows by default
            this.bindMulticast = process.platform === 'win32'
        } else {
          this.bindMulticast = bindMulticast
        }

        this.roku_uuid = uuid5(uuid5.OID, rokuUsn)

        this.roku_info = formatInfoTemplate({uuid:this.roku_uuid,
                                              usn:this.rokuUsn})
        this.device_info = formatDeviceInfoTemplate({uuid:this.roku_uuid,
                                              usn:this.rokuUsn})

        this.discovery_proto = null
        this.api_runner = null
        }
      
    private async roku_root_handler(self, request) {
        return web.Response(body=this.roku_info,
                            headers={'Content-Type': 'text/xml'})
        }
        
    private async roku_input_handler(self, request) {
        return web.Response()
    }
    
    private async roku_keydown_handler(self, request) {
        key = request.match_info['key']
        this.handler.on_keydown(this.roku_usn, key)
        return web.Response()
    }
    
    private async roku_keyup_handler(self, request) {
        key = request.match_info['key']
        this.handler.on_keyup(this.roku_usn, key)
        return web.Response()
    }
    
    private async roku_keypress_handler(self, request) {
        key = request.match_info['key']
        this.handler.on_keypress(this.roku_usn, key)
        return web.Response()
    }
    
    private async roku_launch_handler(self, request) {
        app_id = request.match_info['id']
        this.handler.launch(this.roku_usn, app_id)
        return web.Response()
    }
    
    private async roku_apps_handler(self, request) {
        return web.Response(body=APPS_TEMPLATE,
                            headers={'Content-Type': 'text/xml'})
        }
        
    private async roku_active_app_handler(self, request) {
        return web.Response(body=ACTIVE_APP_TEMPLATE,
                            headers={'Content-Type': 'text/xml'})
        }
        
    private async roku_app_icon_handler(self, request) {
        return web.Response(body=APP_PLACEHOLDER_ICON,
                            headers={'Content-Type': 'image/png'})
        }
        
    private async roku_search_handler(self, request) {
        return web.Response()
    }
    
    private async roku_info_handler(self, request) {
        return web.Response(body=this.device_info,
                            headers={'Content-Type': 'text/xml'})
      }

    @web.middleware
    async def _check_remote_and_host_ip(self, request, handler):
        # only allow access by advertised address or bound ip:[port]
        # (prevents dns rebinding)
        if request.host not in this.allowed_hosts:
            _LOGGER.warning("Rejected non-advertised access by host %s",
                            request.host)
            raise web.HTTPForbidden

        # only allow local network access
        if not ip_address(request.remote).is_private:
            _LOGGER.warning("Rejected non-local access from remote %s",
                            request.remote)
            raise web.HTTPForbidden

        return await handler(request)

    async def _setup_app(self) -> web.AppRunner:
        app = web.Application(loop=this.loop,
                              middlewares=[this._check_remote_and_host_ip])

        app.router.add_route('GET', "/", this._roku_root_handler)

        app.router.add_route('POST', "/keydown/{key}",
                             this._roku_keydown_handler)
        app.router.add_route('POST', "/keyup/{key}",
                             this._roku_keyup_handler)
        app.router.add_route('POST', "/keypress/{key}",
                             this._roku_keypress_handler)
        app.router.add_route('POST', "/launch/{id}",
                             this._roku_launch_handler)
        app.router.add_route('POST', "/input",
                             this._roku_input_handler)
        app.router.add_route('POST', "/search",
                             this._roku_search_handler)

        app.router.add_route('GET', "/query/apps",
                             this._roku_apps_handler)
        app.router.add_route('GET', "/query/icon/{id}",
                             this._roku_app_icon_handler)
        app.router.add_route('GET', "/query/active-app",
                             this._roku_active_app_handler)
        app.router.add_route('GET', "/query/device-info",
                             this._roku_info_handler)

        api_runner = web.AppRunner(app)

        await api_runner.setup()

        return api_runner

    async def start(self) -> None:
        """Start the Roku API server and discovery endpoint."""
        _LOGGER.debug("roku_api:starting server %s:%s",
                      this.host_ip, this.listen_port)

        # set up the HTTP server
        this.api_runner = await this._setup_app()

        api_endpoint = web.TCPSite(this.api_runner,
                                   this.host_ip, this.listen_port)

        await api_endpoint.start()

        this.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        
        this.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

        this.sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                        socket.inet_aton(MULTICAST_GROUP) +
                        socket.inet_aton(this.host_ip))

        if this.bind_multicast:
            this.sock.bind(("", MULTICAST_PORT))
        else:
            this.sock.bind((this.host_ip, MULTICAST_PORT))

        # set up the SSDP discovery server
        _, this.discovery_proto = await this.loop.create_datagram_endpoint(
            lambda: EmulatedRokuDiscoveryProtocol(this.loop,
                                                  this.host_ip, this.roku_usn,
                                                  this.advertise_ip,
                                                  this.advertise_port),
            sock=this.sock)

    async def close(self) -> None:
        """Close the Roku API server and discovery endpoint."""
        _LOGGER.debug("roku_api:closing server %s:%s",
                      this.host_ip, this.listen_port)

        if this.discovery_proto:
            this.discovery_proto.close()
            this.discovery_proto = None

        if this.api_runner:
            await this.api_runner.cleanup()
            this.api_runner = None
        }