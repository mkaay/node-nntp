/*
 *  TODO: - keepalive timer (< 3 min intervals)
 *        - TLS support (port 563)
 */

var util = require('util'),
    net = require('net'),
    EventEmitter = require('events').EventEmitter,
    Buffy = require('./deps/buffy'),
    respsML = [100, 101, 215, 220, 221, 222, 224, 225, 230, 231],
    respsHaveArgs = [111, 211, 220, 221, 222, 223, 401],
    bytesCRLF = [13, 10],
    debug = false;

var NNTP = module.exports = function(options) {
  this._socket = undefined;
  this._state = undefined;
  this._MLEmitter = undefined;
  this._caps = undefined;
  this._buffer = false;
  this._buffy = undefined;
  this._curGroup = undefined;
  this._queue = [];
  this.options = {
    host: 'localhost',
    port: 119,
    /*secure: false,*/
    connTimeout: 60000, // in ms
    debug: false
  };
  extend(true, this.options, options);
  if (typeof this.options.debug === 'function')
    debug = this.options.debug;
};
util.inherits(NNTP, EventEmitter);

NNTP.prototype.connect = function(port, host) {
  var self = this, socket = this._socket, curData = '', curDataBin = [];
  this.options.port = port = port || this.options.port;
  this.options.host = host = host || this.options.host;

  this._caps = new Object();
  this._state = this._curGroup = this._caps = undefined;
  this._queue = [];

  if (socket)
    socket.end();

  var connTimeout = setTimeout(function() {
    self._socket.destroy();
    self._socket = undefined;
    self.emit('timeout');
  }, this.options.connTimeout);
  socket = this._socket = net.createConnection(port, host);
  socket.setTimeout(0);
  socket.on('connect', function() {
    clearTimeout(connTimeout);
    if (debug)
      debug('Connected');
  });
  socket.on('end', function() {
    if (debug)
      debug('Disconnected');
    self.emit('end');
  });
  socket.on('close', function(hasError) {
    clearTimeout(connTimeout);
    self.emit('close', hasError);
  });
  socket.on('error', function(err) {
    self.emit('error', err);
  });
  var code = undefined, text, hasProcessed = false, isML = false, idxCRLF,
      idxStart = 0, idxBStart = 0, idxBCRLF;
  socket.on('data', function(data) {
    if (self._buffer)
      self._buffy.append(data);
    curData += data;
    while ((idxCRLF = curData.indexOf('\r\n', idxStart)) > -1
           || (self._buffer &&
               (idxBCRLF = self._buffy.indexOf(bytesCRLF, idxBStart)) > -1)) {
      if (self._buffer) {
        var r = self._buffy.GCBefore(idxBStart);
        if (r > 0 && idxBStart > 0)
          idxBStart -= r;
        idxBCRLF = self._buffy.indexOf(bytesCRLF, idxBStart);
      }
      hasProcessed = true;
      if (!code) {
        // new response
        code = parseInt(curData.substring(idxStart, 3), 10);
        text = curData.substring(3, idxCRLF).trim();
        if (isML = (respsML.indexOf(code) > -1
                    || (code === 211 && self._queue[0][0] === 'LISTGROUP')))
          self._MLEmitter = new EventEmitter();
        if (debug) {
          debug('Response: code = ' + code + ' (multiline: ' + isML + ')'
                + (text ? '; text = ' + util.inspect(text) : ''));
        }
        if (respsHaveArgs.indexOf(code) > -1)
          text = parseInitLine(code, text);

        if (!self._state) {
          if (code === 200 || code === 201) {
            self._state = 'connected';
            code = undefined;
            hasProcessed = false;
            curData = '';
            idxStart = 0;
            if (!self._refreshCaps(function() { self.emit('connect'); })) {
              self._state = undefined;
              self.emit('error', new Error('Connection severed'));
            }
          } else
            self.emit('error', makeError(code, text));
          return;
        } else {
          if (code >= 400 && code < 600)
            self._callCb(makeError(code, text));
          else {
            // Non-errors/failures
            if (code === 340) {
              // generated by POST -- "go ahead and send me the article"
              // thus, not really an "end response code"
              var cur = self._queue[0];
              if (cur)
                (cur.length === 3 ? cur[2] : cur[1])();
            } else {
              if (respsHaveArgs.indexOf(code) > -1) {
                if (isML)
                  self._callCb(self._MLEmitter, text);
                else
                  self._callCb(text);
              } else if (isML)
                self._callCb(self._MLEmitter);
              else if (code === 381) // asking for password
                self._callCb(true);
              else
                self._callCb();
              /*var group = getGroup(code); // second digit
              if (group === 0) {
                // Connection, setup, and miscellaneous messages
              } else if (group === 1) {
                // Newsgroup selection
              } else if (group === 2) {
                // Article selection
              } else if (group === 3) {
                // Distribution functions
              } else if (group === 4) {
                // Posting
              } else if (group === 8) {
                // Reserved for authentication and privacy extensions
              } else if (group === 9) {
                // Reserved for private use (non-standard extensions)
              }*/
            }
          }
        }
        if (!isML && code !== 340) {
          code = undefined;
          self.send();
        }
      } else {
        // continued response
        if ((idxCRLF - idxStart === 1 && curData[idxStart] === '.')
            || (self._buffer && idxBCRLF - idxBStart === 1 && self._buffy.get(0) === 46)) {
          code = undefined;
          self._setBinMode(false);
          self._MLEmitter.emit('end');
          self.send();
        } else if (self._buffer) {
          var size = (idxBCRLF - idxBStart);
          if (size >= 2 && self._buffy.get(idxBStart) === 46) {
            // for "dot-stuffed" lines
            --size;
            ++idxBStart;
          }
          var buf = new Buffer(size);
          if (idxBCRLF !== idxBStart)
            self._buffy.copy(buf, 0, idxBStart, idxBCRLF);
          self._MLEmitter.emit('line', buf);
        } else
          self._MLEmitter.emit('line', curData.substring(idxStart, idxCRLF));
      }
      if (idxCRLF > -1)
        idxStart = idxCRLF + 2;
      if (idxBCRLF > -1)
        idxBStart = idxBCRLF + 2;
    }
    if (hasProcessed) {
      if (idxStart >= curData.length)
        curData = '';
      else
        curData = curData.substring(idxStart);
      if (self._buffer) {
        if (idxBStart >= self._buffy.length)
          self._buffy = new Buffy();
        else {
          var buf = new Buffer(self._buffy.length - idxBStart);
          self._buffy.copy(buf, 0, idxBStart);
          self._buffy = new Buffy();
          self._buffy.append(buf);
        }
        idxBStart = 0;
      }
      idxStart = 0;
      hasProcessed = false;
    }
  });
};

NNTP.prototype.end = function() {
  if (this._socket)
    this._socket.end();

  this._socket = undefined;
};

/* Standard/Common features */

NNTP.prototype.auth = function(user, password, callback) {
  if (!this._state || this._state === 'authorized')
    return false;

  if (typeof user === 'function')
    return false;
  else if (typeof password === 'function') {
    callback = password;
    password = undefined;
  }

  var self = this;
  return this.send('AUTHINFO USER', user, function(e, needCont) {
    if (e)
      return callback(e);
    if (needCont) {
      if (!password)
        return callback(new Error('Server requires a password'));
      process.nextTick(function() {
        var r = self.send('AUTHINFO PASS', password, function(e) {
          if (!e)
            self._state = 'authorized';
          process.nextTick(function() { callback(e); });
        });
        if (!r)
          return callback(new Error('Connection severed'));
      });
    } else {
      self._state = 'authorized';
      process.nextTick(function() { callback(); });
    }
  });
};

NNTP.prototype.groups = function(search, skipEmpty, cb) {
  if (!this._state)
    return false;
  if (typeof search === 'function') {
    cb = search;
    search = '';
    skipEmpty = true;
  } else if (typeof skipEmpty === 'function') {
    cb = skipEmpty;
    skipEmpty = true;
  }
  if (Array.isArray(search))
    search = search.join(',');
  search = (search ? ' ' + search : '');
  var self = this;
  return this.send('LIST', 'ACTIVE' + search, function(e, mle) {
    if (e)
      return cb(e);
    var emitter = new EventEmitter();
    mle.on('line', function(line) {
      var msgCount;
      line = line.split(' ');
      line[1] = parseInt(line[1], 10);
      line[2] = parseInt(line[2], 10);
      msgCount = (line[1] - line[2]) + 1;
      if (line[1] === 10000000000000000 || line[2] === 10000000000000000)
        msgCount += 1;
      if (!skipEmpty || msgCount > 0)
        emitter.emit('group', name, count, status);
    });
    mle.on('end', function() {
      emitter.emit('end');
    });
    cb(undefined, emitter);
  });
};

NNTP.prototype.groupsDescr = function(search, cb) {
  if (!this._state)
    return false;
  if (typeof search === 'function') {
    cb = search;
    search = '';
  } else if (Array.isArray(search))
    search = search.join(',');
  search = (search ? ' ' + search : '');
  var self = this, reMatch = /^(.+?)\s+(.+)$/;
  return this.send('LIST', 'NEWSGROUPS' + search, function(e, mle) {
    if (e)
      return cb(e);
    var emitter = new EventEmitter();
    mle.on('line', function(line) {
      line = line.match(reMatch);
      emitter.emit('group', line[1], line[2]);
    });
    mle.on('end', function() {
      emitter.emit('end');
    });
    cb(undefined, emitter);
  });
};

// server's UTC date and time
NNTP.prototype.dateTime = function(cb) {
  if (!this._state)
    return false;
  return this.send('DATE', cb);
};

NNTP.prototype.articlesSince = function(search, date8, time6, cb) {
  if (!this._state || typeof search === 'function'
      || typeof date8 === 'function'
      || (typeof time6 === 'function' && !(date8 instanceof Date)))
    return false;
  if (typeof time6 === 'function') {
    cb = time6;
    time6 = padLeft(''+date8.getUTCHours(),2,'0')
            + padLeft(''+date8.getUTCMinutes(),2,'0')
            + padLeft(''+date8.getUTCSeconds(),2,'0');
    date8 = ''+date8.getUTCFullYear()
            + padLeft(''+date8.getUTCMonth(),2,'0')
            + padLeft(''+date8.getUTCDate(),2,'0');
  }
  if (Array.isArray(search))
    search = search.join(',');
  search = (search ? ' ' + search : '');
  var self = this;
  return this.send('NEWNEWS', search + ' ' + date8 + ' ' + time6
                              + ' GMT', function(e, mle) {
    if (e)
      return cb(e);
    var emitter = new EventEmitter();
    mle.on('line', function(line) {
      emitter.emit('articleId', line);
    });
    mle.on('end', function() {
      emitter.emit('end');
    });
    cb(undefined, emitter);
  });
};

NNTP.prototype.articleExists = function(id, cb) {
  if (!this._state || typeof id === 'function')
    return false;
  return this.send('STAT', id, function(e) {
    if (e) {
      if (e.code === 430)
        cb(undefined, false);
      else
        cb(e);
    } else
      cb(undefined, true);
  });
};

NNTP.prototype.group = function(group, cb) {
  if (!this._state || typeof group !== 'string')
    return false;
  var self = this;
  return this.send('GROUP', group, function(e, text) {
    if (!e)
      self._curGroup = group;
    cb(e, text);
  });
};

NNTP.prototype.articleNext = function(cb) {
  if (!this._state || !this._curGroup)
    return false;
  return this.send('NEXT', cb);
};

NNTP.prototype.articlePrev = function(cb) {
  if (!this._state || !this._curGroup)
    return false;
  return this.send('LAST', cb);
};

NNTP.prototype.post = function(msg, cb) {
  if (!this._state || !msg || Object.keys(msg))
    return false;

  var self = this, composing = true;
  return this.send('POST', function(e) {
    if (e || !composing)
      return cb(e);
    composing = false;
    var CRLF = '\r\n',
        text = 'From: "' + msg.from.name + '" <' + msg.from.email + '>' + CRLF
             + 'Newsgroups: ' + (Array.isArray(msg.groups) ? msg.groups.join(',') : msg.groups) + CRLF
             + 'Subject: ' + msg.subject + CRLF
             + CRLF
             + msg.body.replace(/\r\n/g, '\n')
                       .replace(/\r/g, '\n')
                       .replace(/\n/g, '\r\n')
                       .replace(/^\.([^.]*?)/gm, '..$1');
    self._socket.write(text + '\r\n.\r\n');
  });
};

NNTP.prototype.headers = function(who, cb) {
  if (!this._state || (!this._curGroup && typeof who === 'function'))
    return false;
  if (typeof who === 'function') {
    cb = who;
    who = undefined;
  }
  var self = this;
  return this.send('HEAD', who, function(e, mle, msgid) {
    if (e)
      return cb(e);
    var emitter = new EventEmitter(), prevField, prevVal;
    mle.on('line', function(line) {
      if (/^\s+/.test(line))
        prevVal += line;
      else {
        if (prevField)
          emitter.emit('header', prevField, prevVal);
        var idxSep = line.indexOf(": ");
        prevField = line.substring(0, idxSep);
        prevVal = line.substring(idxSep+2);
      }
    });
    mle.on('end', function() {
      emitter.emit('header', prevField, prevVal);
      emitter.emit('end');
    });
    cb(undefined, emitter, msgid);
  });
};

NNTP.prototype.body = function(who, cb) {
  if (!this._state || (!this._curGroup && typeof who === 'function'))
    return false;
  if (typeof who === 'function') {
    cb = who;
    who = undefined;
  }
  var self = this;
  this._setBinMode(true);
  return this.send('BODY', who, function(e, mle, msgid) {
    if (e)
      return cb(e);
    var emitter = new EventEmitter();
    mle.on('line', function(line) {
      emitter.emit('line', line);
    });
    mle.on('end', function() {
      emitter.emit('end');
    });
    cb(undefined, emitter, msgid);
  });
};

NNTP.prototype.article = function(who, cb) {
  if (!this._state || (!this._curGroup && typeof who === 'function'))
    return false;
  if (typeof who === 'function') {
    cb = who;
    who = undefined;
  }
  var self = this;
  this._setBinMode(true);
  return this.send('ARTICLE', who, function(e, mle, msgid) {
    if (e)
      return cb(e);
    var emitter = new EventEmitter(), prevField, prevVal, inHeaders = true;
    mle.on('line', function(line) {
      if (inHeaders) {
        line = ''+line;
        if (/^[\t ]/.test(line))
          prevVal += line;
        else if (line.length) {
          if (prevField)
            emitter.emit('header', prevField, prevVal);
          var idxSep = line.indexOf(": ");
          prevField = line.substring(0, idxSep);
          prevVal = line.substring(idxSep+2);
        } else {
          emitter.emit('header', prevField, prevVal);
          inHeaders = false;
        }
      } else
        emitter.emit('line', line);
    });
    mle.on('end', function() {
      emitter.emit('end');
    });
    cb(undefined, emitter, msgid);
  });
};


/* Extended features */

// TODO


/* Internal helper methods */

NNTP.prototype.send = function(cmd, params, cb) {
  if (!this._socket || !this._socket.writable)
    return false;

  if (cmd) {
    cmd = (''+cmd).toUpperCase();
    if (typeof params === 'function') {
      cb = params;
      params = undefined;
    }
    if (!params)
      this._queue.push([cmd, cb]);
    else
      this._queue.push([cmd, params, cb]);
  }
  if (this._queue.length) {
    var fullcmd = this._queue[0][0]
                  + (this._queue[0].length === 3 ? ' ' + this._queue[0][1] : '');
    if (debug)
      debug('> ' + fullcmd);
    this._socket.write(fullcmd + '\r\n');
  }

  return true;
};

NNTP.prototype._setBinMode = function(isBinary) {
  if (isBinary) {
    this._buffy = new Buffy();
    this._buffer = true;
  } else {
    this._buffer = false;
    this._buffy = undefined;
  }
};

NNTP.prototype._refreshCaps = function(cb) {
  var self = this;
  return this.send('CAPABILITIES', function (e, text) {
    if (!e && /\r\n\.\r\n$/.test(text)) {
      self._caps = new Object();
      var caps = text.split(/\r\n/);
      if (caps.length > 3) {
        caps.shift(); // initial response
        caps.pop(); // '.'
        caps.pop(); // ''
        for (var i=0,sp,len=caps.length; i<len; ++i) {
          caps[i] = caps[i].trim();
          if ((sp = caps[i].indexOf(' ')) > -1)
            self._caps[caps[i].substring(0, sp).toUpperCase()] = caps[i].substring(sp+1);
          else
            self._caps[caps[i].toUpperCase()] = true;
        }
      }
      if (debug)
        debug('Capabilities Updated: ' + util.inspect(self._caps));
    }
    process.nextTick(function() { cb(); });
  });
};

NNTP.prototype._callCb = function(arg1, arg2) {
  if (!this._queue.length)
    return;
  var req = this._queue.shift(), cb = (req.length === 3 ? req[2] : req[1]);
  if (!cb)
    return;

  if (arg1 instanceof Error)
    cb(arg1);
  else if (typeof arg1 !== 'undefined' && arg2 !== 'undefined')
    cb(undefined, arg1, arg2);
  else if (typeof arg1 !== 'undefined')
    cb(undefined, arg1);
  else
    cb();
};


/******************************************************************************/
/***************************** Utility functions ******************************/
/******************************************************************************/
function padLeft(str, size, pad) {
  var ret = str;
  if (str.length < size) {
    for (var i=0,len=(size-str.length); i<len; ++i)
      ret = pad + ret;
  }
  return ret;
}
function parseInitLine(code, text) {
  var ret;
  if (code === 111) {
    // a date: yyyymmddhhmmss (24 hour UTC)
    ret = new Object();
    ret.year = parseInt(text.substring(0, 4), 10);
    ret.month = parseInt(text.substring(4, 6), 10);
    ret.date = parseInt(text.substring(6, 8), 10);
    ret.hour = parseInt(text.substring(8, 10), 10);
    ret.minute = parseInt(text.substring(10, 12), 10);
    ret.second = parseInt(text.substring(12, 14), 10);
  } else if (code === 211) {
    text = text.split(' ');
    ret = new Object();
    ret.name = text[3];
    text[0] = parseInt(text[0], 10); // estimated count
    text[1] = parseInt(text[1], 10); // low article num
    text[2] = parseInt(text[2], 10); // high article num
    // empty group checks as per RFC3977
    if (text[0] === 0 && ((text[1] === 0 && text[2] === 0) || (text[1] <= text[2])
                          || (text[2] === text[1]-1)))
      ret.count = 0;
    else
      ret.count = text[0];
  } else if (code >= 220 && code <= 223) {
    // just return the message-id
    var idxSP = text.indexOf(' ');
    ret = text.substring(idxSP+1);
  } else if (code === 401)
    ret = text;
  return ret;
}

function makeError(code, text) {
  var err = new Error('Server Error: ' + code + (text ? ' ' + text : ''));
  err.code = code;
  err.text = text;
  return err;
}

function getGroup(code) {
  return parseInt(code/10)%10;
}

/**
 * Adopted from jquery's extend method. Under the terms of MIT License.
 *
 * http://code.jquery.com/jquery-1.4.2.js
 *
 * Modified by Brian White to use Array.isArray instead of the custom isArray method
 */
function extend() {
  // copy reference to target object
  var target = arguments[0] || {}, i = 1, length = arguments.length, deep = false, options, name, src, copy;
  // Handle a deep copy situation
  if (typeof target === "boolean") {
    deep = target;
    target = arguments[1] || {};
    // skip the boolean and the target
    i = 2;
  }
  // Handle case when target is a string or something (possible in deep copy)
  if (typeof target !== "object" && !typeof target === 'function')
    target = {};
  var isPlainObject = function(obj) {
    // Must be an Object.
    // Because of IE, we also have to check the presence of the constructor property.
    // Make sure that DOM nodes and window objects don't pass through, as well
    if (!obj || toString.call(obj) !== "[object Object]" || obj.nodeType || obj.setInterval)
      return false;
    var has_own_constructor = hasOwnProperty.call(obj, "constructor");
    var has_is_property_of_method = hasOwnProperty.call(obj.constructor.prototype, "isPrototypeOf");
    // Not own constructor property must be Object
    if (obj.constructor && !has_own_constructor && !has_is_property_of_method)
      return false;
    // Own properties are enumerated firstly, so to speed up,
    // if last one is own, then all properties are own.
    var last_key;
    for (key in obj)
      last_key = key;
    return typeof last_key === "undefined" || hasOwnProperty.call(obj, last_key);
  };
  for (; i < length; i++) {
    // Only deal with non-null/undefined values
    if ((options = arguments[i]) !== null) {
      // Extend the base object
      for (name in options) {
        src = target[name];
        copy = options[name];
        // Prevent never-ending loop
        if (target === copy)
            continue;
        // Recurse if we're merging object literal values or arrays
        if (deep && copy && (isPlainObject(copy) || Array.isArray(copy))) {
          var clone = src && (isPlainObject(src) || Array.isArray(src)) ? src : Array.isArray(copy) ? [] : {};
          // Never move original objects, clone them
          target[name] = extend(deep, clone, copy);
        // Don't bring in undefined values
        } else if (typeof copy !== "undefined")
          target[name] = copy;
      }
    }
  }
  // Return the modified object
  return target;
}

Buffer.prototype.indexOf = function(subject, start) {
  var search = (Array.isArray(subject) ? subject : [subject]),
      searchLen = search.length,
      ret = -1, i, j, len;
  for (i=start||0,len=this.length; i<len; ++i) {
    if (this[i] == search[0] && (len-i) >= searchLen) {
      if (searchLen > 1) {
        for (j=1; j<searchLen; ++j) {
          if (this[i+j] != search[j])
            break;
          else if (j == searchLen-1) {
            ret = i;
            break;
          }
        }
      } else
        ret = i;
      if (ret > -1)
        break;
    }
  }
  return ret;
};


// Target API:
//
//  var s = require('net').createStream(25, 'smtp.example.com');
//  s.on('connect', function() {
//   require('starttls')(s, options, function() {
//      if (!s.authorized) {
//        s.destroy();
//        return;
//      }
//
//      s.end("hello world\n");
//    });
//  });
function starttls(socket, options, cb) {
  var sslcontext = require('crypto').createCredentials(options),
      pair = require('tls').createSecurePair(sslcontext, false),
      cleartext = _pipe(pair, socket);
  pair.on('secure', function() {
    var verifyError = pair._ssl.verifyError();
    if (verifyError) {
      cleartext.authorized = false;
      cleartext.authorizationError = verifyError;
    } else
      cleartext.authorized = true;
    if (cb)
      cb();
  });
  cleartext._controlReleased = true;
  return cleartext;
};
function _pipe(pair, socket) {
  pair.encrypted.pipe(socket);
  socket.pipe(pair.encrypted);

  pair.fd = socket.fd;
  var cleartext = pair.cleartext;
  cleartext.socket = socket;
  cleartext.encrypted = pair.encrypted;
  cleartext.authorized = false;

  function onerror(e) {
    if (cleartext._controlReleased)
      cleartext.emit('error', e);
  }
  function onclose() {
    socket.removeListener('error', onerror);
    socket.removeListener('close', onclose);
  }
  socket.on('error', onerror);
  socket.on('close', onclose);
  return cleartext;
}