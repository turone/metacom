const CALL_TIMEOUT = 7 * 1000;
const PING_INTERVAL = 60 * 1000;
const RECONNECT_TIMEOUT = 2 * 1000;

const connections = new Set();

window.addEventListener('online', () => {
  for (const connection of connections) {
    if (!connection.connected) connection.open();
  }
});

class MetacomError extends Error {
  constructor({ message, code }) {
    super(message);
    this.code = code;
  }
}

class MetacomInterface {
  constructor() {
    this._events = new Map();
  }

  on(name, fn) {
    const event = this._events.get(name);
    if (event) event.add(fn);
    else this._events.set(name, new Set([fn]));
  }

  emit(name, ...args) {
    const event = this._events.get(name);
    if (!event) return;
    for (const fn of event.values()) fn(...args);
  }
}

export class Metacom {
  constructor(url, options = {}) {
    this.url = url;
    this.socket = null;
    this.api = {};
    this.callId = 0;
    this.calls = new Map();
    this.active = false;
    this.connected = false;
    this.lastActivity = new Date().getTime();
    this.callTimeout = options.callTimeout || CALL_TIMEOUT;
    this.pingInterval = options.pingInterval || PING_INTERVAL;
    this.reconnectTimeout = options.reconnectTimeout || RECONNECT_TIMEOUT;
    this.open();
  }

  async open() {
    if (this.connected) return;
    const socket = new WebSocket(this.url);
    this.active = true;
    this.socket = socket;
    connections.add(this);

    socket.addEventListener('message', ({ data }) => {
      this.message(data);
    });

    socket.addEventListener('close', () => {
      this.connected = false;
      setTimeout(() => {
        if (this.active) this.open();
      }, this.reconnectTimeout);
    });

    socket.addEventListener('error', () => {
      socket.close();
    });

    setInterval(() => {
      if (this.active) {
        const interval = new Date().getTime() - this.lastActivity;
        if (interval > this.pingInterval) this.send('{}');
      }
    }, this.pingInterval);

    return new Promise(resolve => {
      socket.addEventListener('open', () => {
        this.connected = true;
        resolve();
      });
    });
  }

  close() {
    this.active = false;
    connections.delete(this);
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  message(data) {
    if (data === '{}') return;
    this.lastActivity = new Date().getTime();
    let packet;
    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }
    const [callType, target] = Object.keys(packet);
    const callId = packet[callType];
    const args = packet[target];
    if (callId && args) {
      if (callType === 'callback') {
        const promised = this.calls.get(callId);
        if (!promised) return;
        const [resolve, reject] = promised;
        if (packet.error) {
          reject(new MetacomError(packet.error));
          return;
        }
        resolve(args);
        return;
      }
      if (callType === 'event') {
        const [interfaceName, eventName] = target.split('/');
        const metacomInterface = this.api[interfaceName];
        metacomInterface.emit(eventName, args);
      }
    }
  }

  async load(...interfaces) {
    const introspect = this.scaffold('system')('introspect');
    const introspection = await introspect(interfaces);
    const available = Object.keys(introspection);
    for (const interfaceName of interfaces) {
      if (!available.includes(interfaceName)) continue;
      const methods = new MetacomInterface();
      const iface = introspection[interfaceName];
      const request = this.scaffold(interfaceName);
      const methodNames = Object.keys(iface);
      for (const methodName of methodNames) {
        methods[methodName] = request(methodName);
      }
      this.api[interfaceName] = methods;
    }
  }

  scaffold(iname, ver) {
    return methodName => async (args = {}) => {
      const callId = ++this.callId;
      const interfaceName = ver ? `${iname}.${ver}` : iname;
      const target = interfaceName + '/' + methodName;
      if (!this.connected) await this.open();
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (this.calls.has(callId)) {
            this.calls.delete(callId);
            reject(new Error('Request timeout'));
          }
        }, this.callTimeout);
        this.calls.set(callId, [resolve, reject]);
        const packet = { call: callId, [target]: args };
        this.send(JSON.stringify(packet));
      });
    };
  }

  send(data) {
    if (!this.connected) return;
    this.lastActivity = new Date().getTime();
    this.socket.send(data);
  }
}
