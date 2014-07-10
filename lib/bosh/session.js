'use strict';

var EventEmitter = require('events').EventEmitter
  , util = require('util')
  , ltx = require('node-xmpp-core').ltx
  , hat = require('hat')
  , debug = require('debug')('xmpp:bosh:session')

var NS_HTTPBIND = 'http://jabber.org/protocol/httpbind'

/**
 * Gets constructed with a first HTTP request (opts.req & opts.res),
 * but receives more in method handleHTTP().
 *
 * The BOSH server session behaves like a normal socket and emits all proper
 * messages to a connection
 *
 * Implement the follwing methods
 * serializeStanza()
 * write()
 * pause()
 * resume()
 * end()
 *
 * Implement the following events:
 * this.emit('connect');
 * this.emit('data', string);
 * this.emit('end');
 * this.emit('close');
 *
 * License: MIT
 */
function BOSHServerSession(opts) {
    // socket properties
    this.writable = true;
    this.readable = true;

    // Bosh settings
    this.xmlnsAttrs = {
        xmlns: NS_HTTPBIND,
        'xmlns:xmpp': 'urn:xmpp:xbosh',
        'xmlns:stream': 'http://etherx.jabber.org/streams'
    }
    if (opts.xmlns) {
        for (var prefix in opts.xmlns) {
            if (prefix) {
                this.xmlnsAttrs['xmlns:' + prefix] = opts.xmlns[prefix]
            } else {
                this.xmlnsAttrs.xmlns = opts.xmlns[prefix]
            }
        }
    }
    this.streamAttrs = opts.streamAttrs || {}
    this.handshakeAttrs = opts.bodyEl.attrs

    // generate sid
    this.sid = opts.sid || hat()
    // add sid to properties
    this.xmlnsAttrs.sid = this.sid;


    this.nextRid = parseInt(opts.bodyEl.attrs.rid, 10)
    this.wait = parseInt(opts.bodyEl.attrs.wait || '30', 10)
    this.hold = parseInt(opts.bodyEl.attrs.hold || '1', 10)
    this.inQueue = {}
    this.outQueue = []
    this.stanzaQueue = []

    this.maySetConnectionTimeout()

    this.emit('connect');

    this.inQueue[opts.bodyEl.attrs.rid] = opts
    process.nextTick(this.workInQueue.bind(this))
}

util.inherits(BOSHServerSession, EventEmitter)

BOSHServerSession.prototype.name = "BOSH"

/**
 * implementation of socket interface
 * forwards data from connection to http
 */
BOSHServerSession.prototype.write = function (data) {
    this.stanzaQueue.push(data)

    process.nextTick(this.workOutQueue.bind(this))
    // indicate if we flush:
    return this.outQueue.length > 0
}

BOSHServerSession.prototype.serializeStanza = function (s, clbk) {
    clbk(s.toString()); // No specific serialization
};

BOSHServerSession.prototype.pause = function () {};
BOSHServerSession.prototype.resume = function () {};
BOSHServerSession.prototype.end = function () {};

/**
 * internal method to emit data to "Connection"
 */
BOSHServerSession.prototype.sendData = function (data) {
    // emit this data to connection
    debug('emit data: ' + data.toString())
    this.emit('data', data.toString())
};

BOSHServerSession.prototype.closeSocket = function (data) {
    debug('close socket')
    this.emit('end')
    this.emit('close')
};

/**
 * handle http requests
 */
BOSHServerSession.prototype.handleHTTP = function(opts) {
    debug('handle http')
    if (this.inQueue.hasOwnProperty(opts.bodyEl.attrs.rid)) {
        // Already queued? Replace with this request
        var oldOpts = this.inQueue[opts.bodyEl.attrs.rid]
        oldOpts.res.writeHead(
            403,
            { 'Content-Type': 'text/plain' }
        )
        oldOpts.res.end('Request replaced by same RID')
    } else if (parseInt(opts.bodyEl.attrs.rid, 10) < parseInt(this.nextRid, 10)) {
        // This req has already been processed.
        this.outQueue.push(opts)
        return
    }

    if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout)
        delete this.connectionTimeout
    }

    // Set up timeout:
    var self = this
    opts.timer = setTimeout(function() {
        delete opts.timer
        self.onReqTimeout(opts.bodyEl.attrs.rid)
    }, this.wait * 1000)

    // Process...
    this.inQueue[opts.bodyEl.attrs.rid] = opts
    process.nextTick(this.workInQueue.bind(this))
}

BOSHServerSession.prototype.workInQueue = function() {
    debug('run workInQueue')
    if (!this.inQueue.hasOwnProperty(this.nextRid)) {
        // Still waiting for next rid request
        return
    }

    var self = this
    var opts = this.inQueue[this.nextRid]
    delete this.inQueue[this.nextRid]
    this.nextRid++

    // handle message

    // extract values
    var rid = opts.bodyEl.attrs.rid
    var sid = opts.bodyEl.attrs.sid
    var to = opts.bodyEl.attrs.to
    var restart = opts.bodyEl.attrs['xmpp:restart'];
    var xmppv = opts.bodyEl.attrs['xmpp:version'];

    // handle stream start
    if (!restart && rid && !sid) {
        debug('handle stream start')
        // emulate stream creation for connection
        this.sendData("<?xml version='1.0' ?>")
        this.sendData("<stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' to='" + to + "' version='" + xmppv + "'>")
    }

    // handle stream reset
    if (opts.bodyEl.attrs['xmpp:restart'] == "true") {
        debug('reset stream')
        // emulate stream restart for connection
        var stream = "<stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'  to='" + to + "' version='" + xmppv + "'>"
        this.sendData(stream);
    }

    opts.bodyEl.children.forEach(function(stanza) {
        debug('send data: ' + stanza)
        // extract content
        self.sendData(stanza.root().children.toString());
    })

    // Input process, retain response for sending stanzas
    this.outQueue.push(opts)

    if (opts.bodyEl.attrs.type !== 'terminate') {
        debug('schedule response')
        process.nextTick(function() {
            self.workOutQueue()
            self.workInQueue()
        })
    } else {
        debug('terminate connection')
        for (var i = 0; i < this.outQueue.length; i++) {
            opts = this.outQueue[i]
            if (opts.timer) clearTimeout(opts.timer)
            this.respond(opts.res, { type: 'terminate' }, [])
        }
        this.outQueue = []
        this.closeSocket();
    }
}

BOSHServerSession.prototype.workOutQueue = function() {
    debug('run workOutQueue')
    if ((this.stanzaQueue.length < 1) &&
        (this.outQueue.length > 0)) {
        this.emit('drain')
        return
    } else if (this.outQueue.length < 1) {
        return
    }

    // queued stanzas
    var stanzas = this.stanzaQueue
    this.stanzaQueue = []

    // available requests
    var opts = this.outQueue.shift()

    if (opts.timer) {
        clearTimeout(opts.timer)
        delete opts.timer
    }

    // answer
    this.respond(opts.res, {}, stanzas)

    this.maySetConnectionTimeout()
}

BOSHServerSession.prototype.maySetConnectionTimeout = function() {
    if (this.outQueue.length < 1) {
        var self = this
        this.connectionTimeout = setTimeout(function() {
            self.emit('error', new Error('Session timeout'))
            self.emit('close')
        }, 60 * 1000)
    }
}

BOSHServerSession.prototype.onReqTimeout = function(rid) {
    var opts
    if ((opts = this.inQueue[rid])) {
        delete this.inQueue[rid]
    } else {
        for (var i = 0; i < this.outQueue.length; i++) {
            if (this.outQueue[i].bodyEl.attrs.rid === rid) break
        }

        if (i < this.outQueue.length) {
            opts = this.outQueue[i]
            this.outQueue.splice(i, 1)
        } else {
            console.warn('Spurious timeout for BOSH rid', rid)
            return
        }
    }
    this.respond(opts.res, {})
}

BOSHServerSession.prototype.respond = function(res, attrs, children) {
    res.writeHead(
        200,
        { 'Content-Type': 'application/xml; charset=utf-8' }
    )
    for (var k in this.xmlnsAttrs) {
        attrs[k] = this.xmlnsAttrs[k]
    }
    var bodyEl = new ltx.Element('body', attrs)
    if (children) {
        // TODO, we need to filter the stream element
        children.forEach(function (element, index, array) {
            try {
                bodyEl.cnode(ltx.parse(element));
            } catch (err) {
                console.error('could not parse' + element)
            }
        })
    }
    bodyEl.write(function(s) {
        res.write(s)
    })
    res.end()
}

module.exports = BOSHServerSession
