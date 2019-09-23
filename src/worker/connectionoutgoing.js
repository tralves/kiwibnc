const uuidv4 = require('uuid/v4');
const hooks = require('./hooks');
const { ConnectionState, IrcBuffer } = require('./connectionstate');

// Upstream commands can be hot reloaded as they contain no state
let UpstreamCommands = null;

function hotReloadUpstreamCommands() {
    delete require.cache[require.resolve('./upstreamcommands')];
    UpstreamCommands = require('./upstreamcommands');
}

hotReloadUpstreamCommands();

function rand(min, max) {
    return Math.floor(Math.random() * (max - min) + min);
}

class ConnectionOutgoing {
    constructor(_id, db, messages, queue, conDict) {
        let id = _id || uuidv4();
        this.db = db;
        this.state = new ConnectionState(id, db);
        this.state.type = 0;
        this.messages = messages;
        this.queue = queue;
        this.conDict = conDict;

        this.conDict.set(id, this);
    }

    get id() {
        return this.state.conId;
    }

    destroy() {
        this.conDict.delete(this.id);
        this.state.destroy();
    }

    close() {
        this.queue.sendToSockets('connection.close', {
            id: this.id,
        });
    }

    async open() {
        await this.state.loadConnectionInfo();

        let connection = {
            host: this.state.host,
            port: this.state.port,
            tls: this.state.tls,
            id: this.id,
            bindAddress: this.state.bindHost || '',
            family: undefined,
            // servername - force a specific TLS servername
            servername: undefined,
        };

        let hook = await hooks.emit('connection_to_open', {upstream: this, connection });
        if (hook.prevent) {
            return;
        }

        if (connection.host && connection.port) {
            this.queue.sendToSockets('connection.open', connection);
        }
    }

    write(data) {
        this.queue.sendToSockets('connection.data', {id: this.id, data: data});
    }

    writeLine(...params) {
        // If the last param contains a space, turn it into a trailing param
        let lastParam = params[params.length - 1];
        if (params.length > 1 && (lastParam[0] === ':' || lastParam.indexOf(' ') > -1)) {
            params[params.length - 1] = ':' + params[params.length - 1];
        }
        this.write(params.join(' ') + '\r\n');
    }

    async forEachClient(fn, excludeCon) {
        this.state.linkedIncomingConIds.forEach(async (conId) => {
            let clientCon = this.conDict.get(conId);
            if (clientCon && clientCon !== excludeCon) {
                await fn(clientCon);
            }
        });
    }

    async messageFromUpstream(message, raw) {
        await this.state.maybeLoad();

        let passDownstream = await UpstreamCommands.run(message, this);
        if (passDownstream !== false) {
            // Send this data down to any linked clients
            let clients = [];
            this.forEachClient((client) => {
                if (client.state.netRegistered) {
                    clients.push(client);
                }
            });

            let hook = await hooks.emit('message_to_clients', {clients, message});
            if (hook.prevent) {
                return;
            }

            hook.event.clients.forEach(async client => {
                await client.writeMsg(message);
            });
        }
    }

    async onUpstreamConnected() {
        // Reset some state. They will be re-populated when upstream sends its registration burst again
        this.state.connected = true;
        this.state.netRegistered = false;
        this.state.receivedMotd = false;
        this.state.isupports = [];
        this.state.registrationLines = [];

        // tempSet() saves the state
        await this.state.tempSet('reconnecting', null);

        hooks.emit('connection_open', {upstream: this});

        this.writeLine('CAP LS 302');

        if (this.state.password) {
            this.writeLine(`PASS ${this.state.password}`);
        }
        this.writeLine(`NICK ${this.state.nick}`);
        this.writeLine(`USER ${this.state.username} * * ${this.state.realname}`);

        this.forEachClient((client) => {
            client.writeStatus('Network connected!');
        });
    }

    async onUpstreamClosed(err) {
        // If we were trying to reconnect, continue with that instead
        if (this.state.tempGet('reconnecting')) {
            this.reconnect();
            return;
        }

        let shouldReconnect = this.state.connected &&
            this.state.netRegistered;

        this.state.connected = false;
        this.state.netRegistered = false;
        this.state.receivedMotd = false;

        for (let chanName in this.state.buffers) {
            let channel = this.state.buffers[chanName];
            if (channel.joined) {
                this.forEachClient(async (client) => {
                    await client.writeMsgFrom(client.state.nick, 'PART', channel.name);
                });
            }

            channel.joined = false;
        }

        await this.state.save();

        hooks.emit('connection_close', {upstream: this});

        this.forEachClient((client) => {
            let msg = 'Network disconnected';
            if (err && err.code) {
                msg += ' ' + err.code;
            } else if (err && typeof err === 'string') {
                msg += ' ' + err;
            }
            client.writeStatus(msg);

            if (!client.state.netRegistered) {
                client.registerLocalClient();
            }
        });

        if (shouldReconnect) {
            this.reconnect();
        }
    }

    async reconnect() {
        let numAttempts = this.state.tempGet('reconnecting') || 0;
        numAttempts++;
        await this.state.tempSet('reconnecting', numAttempts);

        let reconnectTimeout = (Math.min(numAttempts ** 2, 60) * 1000) + rand(300, 5000);
        l('Reconnection attempt ' + numAttempts + ' in ' + reconnectTimeout + 'ms');

        setTimeout(() => {
            // The user may have forced a reconnect since
            if (this.state.connected) {
                return;
            }

            this.open();
        }, reconnectTimeout);
    }

    iSupportToken(tokenName) {
        let token = this.state.isupports.find((tok) => tok.indexOf(`${tokenName}=`) === 0);
        if (!token) {
            return false;
        }

        return token.replace(`${tokenName}=`, '');
    }

    isChannelName(inp) {
        let types = this.iSupportToken('CHANTYPES') || '#&';
        return types.indexOf(inp[0]) > -1;
    }
}

module.exports = ConnectionOutgoing;
