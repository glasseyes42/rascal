var debug = require('debug')('rascal:Publication')
var format = require('util').format
var _ = require('lodash').mixin({ 'defaultsDeep': require('merge-defaults') })
var uuid = require('uuid').v4
var EventEmitter = require('events').EventEmitter
var deprecations = require('./deprecations')

module.exports = {
    create: function(vhost, config, next) {
        var borrowConfirmChannel = vhost.borrowConfirmChannel.bind(vhost)
        var returnConfirmChannel = vhost.returnConfirmChannel.bind(vhost)
        var borrowChannel = vhost.borrowChannel.bind(vhost)
        var returnChannel = vhost.returnChannel.bind(vhost)

        if (config.exchange && config.confirm) return new Publication(borrowConfirmChannel, returnConfirmChannel, publishToConfirmExchange, config).init(next)
        if (config.exchange) return new Publication(borrowChannel, returnChannel, publishToExchange, config).init(next)
        if (config.queue && config.confirm) return new Publication(borrowConfirmChannel, returnConfirmChannel, sendToConfirmQueue, config).init(next)
        if (config.queue) return new Publication(borrowChannel, returnChannel, sendToQueue, config).init(next)
    }
}

function Publication(borrowChannelFn, returnChannelFn, publishFn, config) {

    var unqualifiedPublicationName = _.once(deprecations.unqualifiedPublicationName)
    var self = this

    this.init = function(next) {
        debug('Initialising publication: %s', config.name)
        return next(null, self)
    }

    this.publish = function(payload, overrides, next) {
        if (config.deprecated) unqualifiedPublicationName(config.name, config.vhost)
        var publishConfig = _.defaultsDeep(overrides, config)
        var content = getContent(payload, publishConfig)
        publishConfig.options.contentType = publishConfig.options.contentType || content.type
        publishConfig.options.messageId = publishConfig.options.messageId || uuid()

        _publish(content.buffer, publishConfig, next)
    }

    this.forward = function(message, overrides, next) {
        var originalQueue = message.properties.headers.rascal.originalQueue
        var publishConfig = _.defaultsDeep(overrides, config, { routingKey: message.fields.routingKey })

        publishConfig.options = _.defaultsDeep(publishConfig.options, message.properties)

        _.set(publishConfig, 'options.headers.rascal.originalExchange', message.fields.exchange)
        _.set(publishConfig, 'options.headers.rascal.originalRoutingKey', message.fields.routingKey)
        _.set(publishConfig, 'options.CC', _.chain([]).concat(publishConfig.options.CC, format('%s.%s', originalQueue, publishConfig.routingKey)).uniq().compact().value())

        _publish(message.content, publishConfig, next)
    }

    function _publish(buffer, publishConfig, next) {
        var emitter = new EventEmitter()
        borrowChannelFn(function(err, channel) {
            if (err) return emitter.emit('error', err)
            var errorHandler = handleChannelError.bind(null, channel, emitter, config)
            var returnHandler = emitter.emit.bind(emitter, 'return')
            addListeners(channel, errorHandler, returnHandler)
            publishFn(channel, buffer, publishConfig, function(err) {
                removeListeners(channel, errorHandler, returnHandler)
                returnChannelFn(channel)
                if (err) return emitter.emit('error', err)
                emitter.emit('success', publishConfig.options.messageId)
            })
        })

        next(null, emitter)
    }

    function getContent(payload, config) {
        if (Buffer.isBuffer(payload)) return bufferMessage(payload)
        if (_.isString(payload)) return textMessage(payload)
        return jsonMessage(payload)
    }

    function bufferMessage(payload) {
        return { buffer: payload, type: undefined }
    }

    function textMessage(payload) {
        return { buffer: new Buffer(payload), type : 'text/plain' }
    }

    function jsonMessage(payload) {
        return { buffer: new Buffer(JSON.stringify(payload)), type: 'application/json' }
    }
}

function addListeners(channel, errorHandler, returnHandler) {
    channel.once('error', errorHandler)
    channel.on('return', returnHandler)
}

function removeListeners(channel, errorHandler, returnHandler) {
    channel.removeListener('error', errorHandler)
    channel.removeListener('return', returnHandler)
}

function publishToExchange(channel, content, config, next) {
    debug('Publishing %d bytes to exchange: %s with routingKeys: %s', content.length, config.exchange, _.compact([].concat(config.routingKey, config.options.CC, config.options.BCC)).join(', '))
    channel.publish(config.destination, config.routingKey, content, config.options)
    next()
}

function publishToConfirmExchange(channel, content, config, next) {
    debug('Publishing %d bytes to confirm exchange: %s with routingKeys: %s', content.length, config.exchange, _.compact([].concat(config.routingKey, config.options.CC, config.options.BCC)).join(', '))
    channel.publish(config.destination, config.routingKey, content, config.options, next)
}

function sendToQueue(channel, content, config, next) {
    debug('Publishing %d bytes to queue: %s', content.length, config.queue)
    channel.sendToQueue(config.destination, content, config.options)
    next()
}

function sendToConfirmQueue(channel, content, config, next) {
    debug('Publishing %d bytes to queue: %s', content.length, config.queue)
    channel.sendToQueue(config.destination, content, config.options, next)
}

function handleChannelError(borked, emitter, config, err) {
    debug('Channel error: %s during publication to %s using channel: %s', err.message, config.name, borked._rascal_id)
    emitter.emit(err)
}
