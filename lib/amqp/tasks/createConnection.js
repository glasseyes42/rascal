'use strict'

var debug = require('debug')('rascal:tasks:createConnection')
var _ = require('lodash')
var amqplib = require('amqplib/callback_api')
var async = require('async')
var uuid = require('uuid').v4;


module.exports = _.curry(function(config, ctx, next) {

    var candidates = _.shuffle(config.connections)
    var attempt = 0

    async.retry(candidates.length, function(cb) {
        var connectionConfig = candidates[attempt++]
        connect(connectionConfig, function(err, connection) {
            if (err) return cb(err)
            ctx.connection = connection
            ctx.connectionConfig = connectionConfig
            cb()
        })
    }, function(err) {
        next(err, config, ctx)
    })

    function connect(connectionConfig, cb) {
        debug('Connecting to broker using url: %s', connectionConfig.loggableUrl)


        // See https://github.com/guidesmiths/rascal/issues/17
        var once = _.once(cb)

        amqplib.connect(connectionConfig.url, function(err, connection) {

            if (err) {
                debug('Received error: %s from %s', err.message, connectionConfig.loggableUrl)
                return once(err)
            }

            connection._rascal_id = uuid();
            debug('Obtained connection: %s', connection._rascal_id)

            /*
             * If an error occurs during initialisation (e.g. if checkExchanges fails),
             * and no error handler has been bound to the connection, then the error will bubble up
             * to the UncaughtException handler, potentially crashing the node process.
             *
             * By adding an error handler now, we ensure that instead of being emitted as events
             * errors will be passed via the callback chain, so they can still be handled by the caller
             *
             * This error handle is removed in the vhost after the initialiation has complete
             */
            connection.on('error', function(err) {
                debug('Received error: %s from %s', err.message, connectionConfig.loggableUrl)
                once(err)
            })

            once(null, connection)
        })
    }
})
