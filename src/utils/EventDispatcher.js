/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, $, jQuery */

/**
 * Implements a jQuery-like event dispatch pattern for non-DOM objects:
 *  - Listeners are attached via on() & detached via off()
 *  - Listeners can use namespaces for easy removal
 *  - Listeners can attach to multiple events at once via a space-separated list
 *  - Events are fired via trigger()
 *  - The same listener can be attached twice, and will be called twice; but off() will detach all
 *    duplicate copies at once ('duplicate' means '===' equality - see http://jsfiddle.net/bf4p29g5/1/)
 * 
 * But it has some important differences from jQuery's non-DOM event mechanism:
 *  - More robust to listeners that throw exceptions (other listeners will still be called, and
 *    trigger() will still return control to its caller).
 *  - Events can be marked deprecated, causing on() to issue warnings
 *  - Easier to debug, since the dispatch code is much simpler
 *  - Faster, for the same reason
 *  - Uses less memory, since $(nonDOMObj).on() leaks memory in jQuery
 *  - API is simplified:
 *      - Event handlers do not have 'this' set to the event dispatcher object
 *      - Event object passed to handlers only has 'type' and 'target' fields
 *      - trigger() uses a simpler argument-list signature (like Promise APIs), rather than requiring
 *        an Array arg and ignoring additional args
 *      - trigger() does not support namespaces
 *      - For simplicity, on() does not accept a map of multiple events -> multiple handlers, nor a
 *        missing arg standing in for a bare 'return false' handler.
 * 
 * For now, Brackets uses a jQuery patch to ensure $(obj).on() and obj.on() (etc.) are identical
 * for any obj that has the EventDispatcher pattern. In the future, this may be deprecated.
 * 
 * To add EventDispatcher methods to any object, call EventDispatcher.makeEventDispatcher(obj).
 */
define(function (require, exports, module) {
    "use strict";
    
    var _ = require("thirdparty/lodash");

    
    /**
     * @param {string} eventName Event name, optionally with trailing ".namespace" part
     * @return {!{event:string, ns:string}} Record containing separate event name and namespace
     */
    function splitNs(eventStr) {
        var dot = eventStr.indexOf(".");
        if (dot === -1) {
            return { eventName: eventStr };
        } else {
            return { eventName: eventStr.substring(0, dot), ns: eventStr.substring(dot) };
        }
    }
    
    
    // These functions are added as mixins to any object by makeEventDispatcher()
    
    /**
     * Adds the given handler function to 'events': a space-separated list of one or more event names, each
     * with an optional ".namespace" (used by off() - see below). If the handler is already listening to this
     * event, another copy is added.
     * @param {string} events
     * @param {!function(!{type:string, target:!Object}, ...)} fn
     */
    var on = function (events, fn) {
        var eventsList = events.split(/\s+/).map(splitNs),
            i;
        
        // Check for deprecation warnings
        if (this._deprecatedEvents) {
            for (i = 0; i < eventsList.length; i++) {
                var deprecation = this._deprecatedEvents[eventsList[i].eventName];
                if (deprecation) {
                    var message = "Registering for deprecated event '" + eventsList[i].eventName + "'.";
                    if (typeof deprecation === "string") {
                        message += " Use " + deprecation + " instead.";
                    }
                    console.warn(message, new Error().stack);
                }
            }
        }
        
        // Attach listener for each event clause
        for (i = 0; i < eventsList.length; i++) {
            var eventName = eventsList[i].eventName;
            if (!this._eventHandlers) {
                this._eventHandlers = {};
            }
            if (!this._eventHandlers[eventName]) {
                this._eventHandlers[eventName] = [];
            }
            eventsList[i].handler = fn;
            this._eventHandlers[eventName].push(eventsList[i]);
        }
        
        return this;  // for chaining
    };
    
    /**
     * Removes one or more handler functions based on the space-separated 'events' list. Each item in
     * 'events' can be: bare event name, bare namespace, or event.namespace pair. This yields a set of
     * matching handlers. If 'fn' is ommitted, all these handlers are removed. If 'fn' is provided,
     * only handlers exactly equal to 'fn' are removed (there may still be >1, if duplicates were
     * added).
     * @param {string} events
     * @param {?function(!{type:string, target:!Object}, ...)} fn
     */
    var off = function (events, fn) {
        var eventsList = events.split(/\s+/).map(splitNs),
            i;
        
        if (!this._eventHandlers) {
            return;
        }
        
        var removeAllMatches = function (eventRec, eventName) {
            var handlerList = this._eventHandlers[eventName],
                k;
            if (!handlerList) {
                return;
            }
            
            // Walk backwards so it's easy to remove items
            for (k = handlerList.length - 1; k >= 0; k--) {
                // Look at ns & fn only - caller has already taken care of eventName
                if (!eventRec.ns || eventRec.ns === handlerList[k].ns) {
                    if (!fn || fn === handlerList[k].handler) {
                        handlerList.splice(k, 1);
                    }
                }
            }
            if (!handlerList.length) {
                delete this._eventHandlers[eventName];
            }
        }.bind(this);
        
        var doRemove = function (eventRec) {
            if (eventRec.eventName) {
                // If arg calls out an event name, look at that handler list only
                removeAllMatches(eventRec, eventRec.eventName);
            } else {
                // If arg only gives a namespace, look at handler lists for all events
                _.forEach(this._eventHandlers, function (handlerList, eventName) {
                    removeAllMatches(eventRec, eventName);
                });
            }
        }.bind(this);
        
        // Detach listener for each event clause
        // Each clause may be: bare eventname, bare .namespace, full eventname.namespace
        for (i = 0; i < eventsList.length; i++) {
            doRemove(eventsList[i]);
        }
        
        return this;  // for chaining
    };
    
    /**
     * Invokes all handlers for the given event (in the order they were added).
     * @param {string} eventName
     * @param {*} ... Any additional args are passed to the event handler after the event object
     */
    var trigger = function (eventName) {
        var event = { type: eventName, target: this },
            handlerList = this._eventHandlers && this._eventHandlers[eventName],
            i;
        
        if (!handlerList) {
            return;
        }

        // Pass 'event' object followed by any additional args trigger() was given
        var applyArgs = Array.prototype.slice.call(arguments, 1);
        applyArgs.unshift(event);

        for (i = 0; i < handlerList.length; i++) {
            try {
                // Call one handler
                handlerList[i].handler.apply(null, applyArgs);
            } catch (err) {
                console.error("Exception in '" + eventName + "' listener on", this, String(err), err.stack);
                console.assert(false);  // causes dev tools to break, just like an uncaught exception
            }
        }
    };
    
    
    /**
     * Adds the EventDispatcher APIs to the given object. May also be called on a prototype object,
     * in which case each instance will behave independently.
     * @param {!Object} obj Object to add event-dispatch methods to
     */
    function makeEventDispatcher(obj) {
        $.extend(obj, {
            on: on,
            off: off,
            trigger: trigger,
            _EventDispatcher: true
        });
        // Later, on() may add _eventHandlers: Object.<string, Array.<{event:string, namespace:?string,
        //   handler:!function(!{type:string, target:!Object}, ...)}>> - map from eventName to an array
        //   of handler records
        // Later, markDeprecated() may add _deprecatedEvents: Object.<string, string|boolean> - map from
        //   eventName to deprecation warning info
    }
    
    /**
     * Mark a given event name as deprecated, such that on() will emit warnings when called with it.
     * May be called before makeEventDispatcher(). May be called on a prototype where makeEventDispatcher()
     * is called separately per instance (in the ctor).
     * @param {!Object} obj Event dispatcher object
     * @param {string} eventName Name of deprecated event
     * @param {string=} insteadStr Suggested thing to use instead
     */
    function markDeprecated(obj, eventName, insteadStr) {
        // Mark event as deprecated - on() will emit warnings when called with this event
        if (!obj._deprecatedEvents) {
            obj._deprecatedEvents = {};
        }
        obj._deprecatedEvents[eventName] = insteadStr || true;
    }
    
    
    exports.makeEventDispatcher = makeEventDispatcher;
    exports.markDeprecated      = markDeprecated;
});
