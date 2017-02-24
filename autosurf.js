/*jslint indent: 2, node: true */
/*global require: false, process: false, download: false, processBatch: false */

// autoSurf.js
//
// Load a chain of operations in json format and execute the operations therein
// to fetch, parse and download data from the web.
//
var http = require('http'),
  https = require('https'),
  path = require('path'),
  fs = require('fs'),
  url = require('url'),
  zlib = require('zlib'),
  htmlparser = require('htmlparser2'), // npm install htmlparser2 -g
  context = {},
  showDebug = false,
  quiet = true,
  hideErrors = true,
  batch = '',
  log = {
    dbg: function () {
      if (showDebug) {
        console.log.apply({}, arguments);
      }
    },
    out: function () {
      if (!quiet) {
        console.log.apply({}, arguments);
      }
    },
    err: function () {
      if (!hideErrors) {
        console.log.apply({}, arguments);
      }
    }
  },
  mkdirp = function (directory, callback) {
    "use strict";

    fs.mkdir(directory, function (err1) {
      if (err1) {
        if (err1.code === 'EEXIST') {
          callback(null);
        } else if (err1.code === 'ENOENT') {
          mkdirp(path.dirname(directory), function (err2) {
            if (err2) {
              callback(err2);
            } else {
              mkdirp(directory, callback);
            }
          });
        } else {
          callback(err1);
        }
      } else {
        callback(null);
      }
    });
  },
  download = function (options, callback) {
    "use strict";

    var downloadStarted = function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          callback(null, res);
        } else {
          if (res.statusCode >= 300 && res.statusCode < 400) {
            if (res.headers.location) {
              download(url.resolve(options.href, res.headers.location), callback);
              return;
            }
          }
          callback(new Error("Bad statusCode " + res.statusCode), null);
        }
      },
      client = http,
      req = {};

    if (typeof options === 'string') {
      options = url.parse(options);
    }
    if (options.protocol === "https:") {
      client = https;
    }
    req = client.get(options, downloadStarted);
    req.on('error', function (err) {
      callback(err, null);
    });
  },
  downloadFile = function (uri, filename, callback) {
    "use strict";

    var saveFile = function (err, res) {
        var file = {};

        if (err) {
          callback(err, {'url': uri});
        } else {
          file = fs.createWriteStream(filename);

          res.on('data', function (chunk) {
            file.write(chunk, 'binary');
          });
          res.on('end', function () {
            file.end();
            callback(null, { 'url': uri, 'filename': filename });
          });
        }
      },
      directoryReady = function (err) {
        if (err && err.code !== 'EEXIST') {
          callback(err, {'url': uri});
        } else {
          download(uri, saveFile);
        }
      },
      directory = path.dirname(filename);
    mkdirp(directory, directoryReady);
  },
  getPage = function (uri, callback) {
    "use strict";

    var processPage = function (err, res) {
        var chunks = [];

        if (err) {
          callback(err, {'url': uri});
        } else {
          res.on('data', function (chunk) {
            chunks.push(chunk);
          });

          res.on('end', function () {
            var buffer = Buffer.concat(chunks),
              decodePage = function (err, decoded) {
                var result = {}, str = '', ct = '';
                if (!err) {
                  result.status = res.statusCode;
                  str = decoded.toString();
                  ct = res.headers["content-type"] || ct;
                  if (ct.indexOf("application/json") > -1) {
                    result.json = JSON.parse(str);
                  } else {
                    result.text = str;
                  }
                }
                callback(err, result);
              };
            switch (res.headers['content-encoding']) {
              case 'gzip':
                zlib.gunzip(buffer, decodePage);
                break;
              case 'deflate':
                zlib.inflate(buffer, decodePage);
                break;
              default:
                decodePage(null, buffer.toString());
                break;
            }
          });
        }
      },
      options = url.parse(uri);

    options.headers = { 'Accept-Encoding': "gzip, deflate" };
    download(uri, processPage);
  },
  parsePage = function (sourceUrl, options, callback) {
    "use strict";

    var opts = {};
    if (options.onopentag) { opts.onopentag = options.onopentag; }
    if (options.ontext) { opts.ontext = options.ontext; }
    if (options.onclosetag) { opts.onclosetag = options.onclosetag; }

    getPage(sourceUrl, function (err, response) {
      var parser = new htmlparser.Parser(opts);

      if (options.oninit) {
        if (!options.oninit()) {
          callback(null);
          return;
        }
      }

      if (err) {
        callback(err, { 'sourceUrl': sourceUrl });
      } else {
        if (response.text) {
          parser.write(response.text);
          parser.end();

          if (options.oncomplete) {
            options.oncomplete();
          }
        } else {
          if (options.onjson) {
            options.onjson(response.json);
          }
        }

        callback(null);
      }
    });
  },
  getUrls = function (sourceUrl, callback) {
    "use strict";

    var results = [],
      whenOpenTag = function (name, attribs) {
        if (name === 'a') {
          if (attribs.href) {
            results.push(url.resolve(sourceUrl, attribs.href));
          }
        } else if (name === 'img') {
          if (attribs.src) {
            results.push(url.resolve(sourceUrl, attribs.src));
          }
          if (attribs["data-src"]) {
            results.push(url.resolve(sourceUrl, attribs["data-src"]));
          }
        } else if (name === 'iframe') {
          if (attribs.src) {
            results.push(url.resolve(sourceUrl, attribs.src));
          }
        } else if (name === 'meta') {
          if (attribs.content) {
            results.push(url.resolve(sourceUrl, attribs.content));
          }
        }
      };
    parsePage(sourceUrl, { onopentag: whenOpenTag }, function (err) {
      if (err) {
        callback(err, { 'sourceUrl': sourceUrl });
      } else {
        callback(null, { 'sourceUrl': sourceUrl, 'urlsFound': results });
      }
    });
  },
  getOperationChain = function (filename, callback) {
    "use strict";

    var result = {};

    fs.readFile(filename, { 'encoding': "utf8" }, function (err, data) {
      if (err) {
        log.err('failed to read operation chain');
        callback(err, null);
      } else {
        result = JSON.parse(data);
        callback(null, result);
      }
    });
  },
  batchWork = function (batchMax, operation, worker, callback) {
    "use strict";

    var elements = Object.getOwnPropertyNames(operation.input),
      count = elements.length,
      batchSize = 0,
      fail = null,
      watchdogs = {},
      clearWatchdog = function (element) {
        if (watchdogs[element]) {
          clearTimeout(watchdogs[element].timer);
          watchdogs[element] = null;
        } else {
          log.err("WATCHDOG NOT FOUND: " + element);
        }
      },
      setWatchdog = function (element, callback) {
        if (watchdogs[element]) {
          log.err("WATCHDOG DUPLICATE: " + element);
        } else {
          watchdogs[element] = {};
          watchdogs[element].callback = callback;
          watchdogs[element].timer = setTimeout(function () {
            log.err("WATCHDOG TIMEOUT: " + element);
            watchdogs[element].callback();
          }, 180000);
        }
      },
      workCallback = function (element, err) {
        batchSize -= 1;
        clearWatchdog(element);
        log.dbg("DBG: " + batchSize + " workers remaing");

        if (err && !fail) {
          log.dbg("DBG: worker Failed ", err);
          fail = err;
        }
        if (batchSize < 1) {
          if (fail) {
            log.dbg("DBG: propagate failure ", fail);
            callback(fail, operation);
          } else if (elements.length < 1) {
            log.dbg("DBG: all ", count, " workers complete");
            callback(null, operation);
          } else {
            log.dbg("DBG: queueing more work");
            processBatch();
          }
        }
      },
      queueWork = function (element) {
        process.nextTick(function () {
          var callback = workCallback.bind(null, element);
          log.dbg("DBG: working ", element);
          setWatchdog(element, callback);
          worker(element, callback);
        });
      },
      processBatch = function () {
        var element = "";
        while (elements.length > 0) {
          element = elements.pop();
          if (element) {
            batchSize += 1;
            log.dbg("DBG: queueing ", element, "(", batchSize, " batchSize)");
            queueWork(element);

            if (batchSize >= batchMax) {
              log.dbg("DBG: yielding");
              return;
            }
          }
        }
      };

    process.nextTick(function () {
      if (count > 0) {
        log.dbg("DBG: batching ", count, " jobs");
        processBatch();
      } else {
        log.dbg("DBG: nothing to do");
        callback(null, operation);
      }
    });
    return count;
  },
  longestCommonSubstring = function (s1, s2) {
    "use strict";

    var LCS = [],
      longest = 0,
      i = 0,
      j = 0,
      result = "";

    for (i = 0; i < s1.length; i += 1) {
      LCS[i] = [];
      for (j = 0; j < s2.length; j += 1) {
        LCS[i][j] = 0;
        if (s1[i] === s2[j]) {
          LCS[i][j] = (i !== 0 && j !== 0) ? LCS[i - 1][j - 1] + 1 : 1;
          if (LCS[i][j] > longest) {
            longest = LCS[i][j];
            result = s1.substring(i - longest + 1, i + 1);
          }
        }
      }
    }
    return result;
  },
  //
  // Downloads all input urls. If pattern is specified,
  // then it is applied against the url so the capture
  // groups can be used with filename and directory. If
  // filename is specified, it saves to that filename
  // (you can use {1} notation to use capture groups
  // from the pattern). If filename is not specified,
  // the name of the file in the url is used. If
  // directory is specified, file is stored there,
  // otherwise in the current directory.
  //
  // The output contains any input urls that failed to
  // download.
  //
  //  {
  //    "operation": "download",
  //    "input": [url, ...],
  //      - optional, if provided it is appended to output of previous operation
  //    "pattern": "^.*/([^/]+)/([^/]+)$"
  //      - optional
  //    "directory": "{1}"
  //      - optional
  //    "filename": "{2}"
  //      - optional
  //  }
  //
  operationDownload = function (operation, callback) {
    "use strict";

    var downloads = 0,
      downloadWorker = function (element, workCallback) {
        var re = new RegExp("^(.*)$"),
          matches = [],
          tags = {},
          filename = '',
          directory = path.resolve('.', '.');

        if (operation.pattern) {
          if (operation.pattern[0] !== '^' || operation.pattern[operation.pattern.length - 1] !== '$') {
            workCallback(new Error('ERROR: pattern must begin with ^ and end with $'));
            return;
          }
          re = new RegExp(operation.pattern);
        }

        matches = element.match(re);
        tags = operation.input[element];

        if (operation.filename) {
          filename = operation.filename.format(matches, tags);
        } else {
          filename = element.substr(element.lastIndexOf('/') + 1);
        }

        if (operation.directory) {
          directory = operation.directory.format(matches, tags);
        }

        filename = path.resolve(directory, filename);

        if (operation.debug) {
          log.out('directory: ' + directory);
          log.out('filename : ' + filename);
          operation.output[element] = operation.input[element];
          operation.output[element].directory = directory;
          operation.output[element].filename = filename;
          workCallback(null);
        } else {
          log.dbg("DBG: Downloading ", element);
          downloadFile(element, filename, function (err, result) {
            if (err) {
              operation.output[result.url] = operation.input[result.url];
              log.err('ERROR downloading: ' + result.url + '\n          message: ' + err.message);
            } else {
              log.out('Downloaded (' + downloads + ' remaining): ' + result.url);
            }
            downloads -= 1;
            workCallback(null);
          });
        }
      };

    downloads = batchWork(4, operation, downloadWorker, callback);
  },
  //
  // Sets up configuration options.
  //
  //  {
  //    "operation": "config",
  //    "contexts": {
  //      "context-name": "context-file.js"
  //    },
  //     - optional, if provided it is appended to output of previous operation
  //    "debug": "false",
  //     - optional (default false)
  //    "quiet": "false",
  //     - optional (default false)
  //    "hideErrors": "false"
  //     - optional (default false)
  //  }
  //
  operationConfig = function (operation, callback) {
    "use strict";

    operation.output = operation.input;
    showDebug = !!operation.debug;
    quiet = !!operation.quiet;
    hideErrors = !!operation.hideErrors;

    if (operation.contexts) {
      Object.getOwnPropertyNames(operation.contexts).forEach(function(name) {
        context[name] = require(path.resolve('.', operation.contexts[name]));
      });
    }

    process.nextTick(function () {
      callback(null, operation);
    });
  },
  //
  // Downloads all the input urls and parses the HTML for
  // urls in <a>, <img>, <iframe> and <meta> tags and
  // adds them to output. If annotate is specified, appends
  // the annotation pattern and the input url to the
  // resulting url to disambiguate duplicates.
  //
  // The output contains urls found from downloading and
  // parsing the input urls.
  //
  //  {
  //    "operation": "geturls",
  //    "input": [url, ...],
  //      - optional, if provided it is appended to output of previous operation
  //    "annotate": "#####"
  //     - optional
  //  }
  //
  operationParse = function (operation, callback) {
    "use strict";

    var pages = 0,
      opts = {},
      parseWorker = function (element, workCallback) {
        var options = {},
          resolveEntry = function(uri) {
            operation.output[uri] = operation.output[uri] || Object.assign({}, operation.input[element]);
            return operation.output[uri];
          },
          resolveUrl = function(uri) {
            if (uri) {
              return url.resolve(element, uri);
            }
            return element;
          };

        if (opts.oninit) {
          options.oninit = opts.oninit.bind(null, element, resolveUrl, resolveEntry, context);
        }
        if (opts.onopentag) {
          options.onopentag = opts.onopentag.bind(null, element, resolveUrl, resolveEntry, context);
        }
        if (opts.ontext) {
          options.ontext = opts.ontext.bind(null, element, resolveUrl, resolveEntry, context);
        }
        if (opts.onclosetag) {
          options.onclosetag = opts.onclosetag.bind(null, element, resolveUrl, resolveEntry, context);
        }
        if (opts.oncomplete) {
          options.oncomplete = opts.oncomplete.bind(null, element, resolveUrl, resolveEntry, context);
        }

        parsePage(element, options, function (err) {
          if (err) {
            log.err('ERROR parsing: ' + element + '\n    message: ' + err.message);
          } else {
            log.out('Parsed (' + pages + ' remaining): ' + element);
          }

          pages -= 1;
          if (pages === 0) {
            if (operation.debug) {
              log.out(operation.output);
            }
          }
          workCallback(null);
        });
      };

    if (operation.oninit) {
      opts.oninit = new Function('sourceUrl', 'resolveUrl', 'resolveEntry', 'ctx', operation.oninit);
    }
    if (operation.onopentag) {
      opts.onopentag = new Function('sourceUrl', 'resolveUrl', 'resolveEntry', 'ctx', 'tagname', 'attribs', operation.onopentag);
    }
    if (operation.ontext) {
      opts.ontext = new Function('sourceUrl', 'resolveUrl', 'resolveEntry', 'ctx', 'text', operation.ontext);
    }
    if (operation.onclosetag) {
      opts.onclosetag = new Function('sourceUrl', 'resolveUrl', 'resolveEntry', 'ctx', 'tagname', operation.onclosetag);
    }
    if (operation.oncomplete) {
      opts.oncomplete = new Function('sourceUrl', 'resolveUrl', 'resolveEntry', 'ctx', operation.oncomplete);
    }
    pages = batchWork(20, operation, parseWorker, callback);
  },
  //
  // Downloads all the input urls and parses the HTML for
  // urls in <a>, <img>, <iframe> and <meta> tags and
  // adds them to output. If annotate is specified, appends
  // the annotation pattern and the input url to the
  // resulting url to disambiguate duplicates.
  //
  // The output contains urls found from downloading and
  // parsing the input urls.
  //
  //  {
  //    "operation": "geturls",
  //    "input": [url, ...],
  //      - optional, if provided it is appended to output of previous operation
  //    "annotate": "#####"
  //     - optional
  //  }
  //
  operationGetUrls = function (operation, callback) {
    "use strict";

    var pages = 0,
      parseWorker = function (element, workCallback) {
        getUrls(element, function (err, result) {
          var i, source = operation.input[result.sourceUrl] || {}, uri;

          if (err) {
            log.err('ERROR parsing: ' + result.sourceUrl + '\n      message: ' + err.message);
          } else {
            for (i = 0; i < result.urlsFound.length; i += 1) {
              uri = result.urlsFound[i];
              if (operation.annotate) {
                uri += operation.annotate + result.sourceUrl;
              }
              operation.output[uri] = Object.assign({}, source);
            }
            log.out('Parsed (' + pages + ' remaining): ' + result.sourceUrl);
          }

          pages -= 1;
          if (pages === 0) {
            if (operation.debug) {
              log.out(operation.output);
            }
          }
          workCallback(null);
        });
      };
    pages = batchWork(20, operation, parseWorker, callback);
  },
  //
  // Copies all input urls that match the include
  // pattern but do not match the exclude pattern to
  // output. If prune is specified, then prunes everything
  // after and including the specified annotation pattern.
  //
  // The output contains any pruned input urls that are
  // included but not excluded.
  //
  //  {
  //    "operation": "filter",
  //    "input": [url, ...],
  //      - optional, if provided it is appended to output of previous operation
  //    "include": "^.*text1.*$",
  //     - optional
  //    "exclude": "^.*text2.*$",
  //     - optional
  //    "prune": "####",
  //     - optional
  //  }
  //
  operationFilter = function (operation, callback) {
    "use strict";

    var inputNames = Object.getOwnPropertyNames(operation.input),
      re = {},
      i = 0,
      j = 0,
      outputNames = [],
      name = "";

    if (operation.include) {
      if (operation.include[0] !== '^' || operation.include[operation.include.length - 1] !== '$') {
        log.err('ERROR: include must begin with ^ and end with $');
        return;
      }

      re = new RegExp(operation.include);

      outputNames = inputNames.filter(function (item) {
        return re.test(item);
      });
    } else {
      outputNames = inputNames;
    }

    if (operation.exclude) {
      if (operation.exclude[0] !== '^' || operation.exclude[operation.exclude.length - 1] !== '$') {
        log.err('ERROR: exclude must begin with ^ and end with $');
        return;
      }

      re = new RegExp(operation.exclude);

      outputNames = outputNames.filter(function (item) {
        return !re.test(item);
      });
    }
    for (i = 0; i < outputNames.length; i += 1) {
      name = outputNames[i];
      if (operation.prune) {
        j = name.indexOf(operation.prune);
        if (j >= 0) {
          name = name.substring(0, j);
        }
      }
      operation.output[name] = operation.input[outputNames[i]];
    }

    if (operation.debug) {
      log.out(operation.output);
    }

    process.nextTick(function () {
      callback(null, operation);
    });
  },
  //
  // Copies all input urls to output. Adds tags that
  // match the specified pattern.
  //
  // {
  //   "operation": "tag",
  //   "input": [url, ...],
  //      - optional, if provided it is appended to output of previous operation
  //   "pattern": "^.*/([0-9]+)/([0-9]+)/([0-9]+)/.*$)",
  //      - optional
  //   "tags": {
  //     "day":"{1}",
  //     "month": "{2}",
  //     "year": "{3}"
  //   }
  //      - optional
  // },
  //
  operationTag = function (operation, callback) {
    "use strict";

    var inputNames = Object.getOwnPropertyNames(operation.input),
      updateTags = function (element) {

        var re,
          i = 0,
          matches = [],
          tags = operation.input[element] || {},
          tagNames = Object.getOwnPropertyNames(operation.tags);

        if (operation.pattern) {
          if (operation.pattern[0] !== '^' || operation.pattern[operation.pattern.length - 1] !== '$') {
            log.err('ERROR: pattern must begin with ^ and end with $');
            return;
          }

          re = new RegExp(operation.pattern);

          matches = element.match(re);
          for (i = 0; i < tagNames.length; i += 1) {
            tags[tagNames[i]] = operation.tags[tagNames[i]].format(matches, tags);
          }
          operation.output[element] = tags;
        }
      };
    operation.tags = operation.tags || {};
    operation.output = operation.input;
    inputNames.forEach(updateTags);

    if (operation.debug) {
      log.out(operation.output);
    }

    process.nextTick(function () {
      callback(null, operation);
    });
  },
  //
  // Generates urls for each pattern in patterns
  // replacing {0} with values from start increased by
  // increment until the value exceeds end.
  //
  //  {
  //    "operation": "generate",
  //    "input": [url, ...],
  //    "patterns": [url, ...],
  //    "start": 2
  //    "increment": 1
  //    "end" : 10
  //    "output": [url, ...] - for each url in patterns replaces {0} with values from start to end increased by increment unitl the value exceeds end
  //  }
  //
  operationGenerate = function (operation, callback) {
    "use strict";

    var patterns = operation.patterns || [],
      count = patterns.length,
      start = operation.start || 0,
      increment = operation.increment || 1,
      end = operation.end || 0,
      i = 0,
      value = 0,
      entry = "";

    operation.output = operation.input;

    for (i = 0; i < count; i += 1) {
      for (value = start; value <= end; value += increment) {
        entry = operation.patterns[i].format([''+value], {});
        operation.output[entry] = operation.output[entry] || {};
      }
    }

    process.nextTick(function () {
      callback(null, operation);
    });
  },
  //
  // Copies input to output. If inputFilename is specified,
  // reads JSON array of strings and appends to output. If
  // outputFilename is specified, writes output as JSON.
  //
  //  {
  //    "operation": "IO",
  //    "input": [url, ...],
  //      - optional, if provided it is appended to output of previous operation
  //    "inputFilename": "{1}"
  //      - optional
  //    "outputFilename": "{1}"
  //      - optional
  //    "padding": "  "
  //      - optional, if provided formats json using
  //        specified padding, otherwise json will have
  //        minimal whitespace
  //  }
  //
  operationIO = function (operation, callback) {
    "use strict";

    var batches = 1,
      processWrite = function (err) {
        batches -= 1;
        log.dbg("DBG: Write complete " + batches + " batches remaining");
        if (err) {
          log.err(err);
        }
        if (batches === 0) {
          if (operation.purge === 'true') {
            operation.output = {};
          }
          callback(null, operation);
        }
      },
      writeFile = function (filename, data) {
        filename = path.resolve('.', filename);
        if (operation.padding) {
          data = JSON.stringify(data, null, operation.padding);
        } else {
          data = JSON.stringify(data);
        }
        fs.writeFile(filename, data, processWrite);
      },
      saveFile = function () {
        var filename = '',
          data = {},
          names = [],
          batchSize = 0,
          i = 0;

        if (operation.outputFilename) {
          filename = operation.outputFilename;
          if (filename.indexOf('{0}') > -1) {
            filename = filename.format([batch],{});
          }
          if (operation.batchSize) {
            names = Object.getOwnPropertyNames(operation.output);
            batchSize = parseInt(operation.batchSize);
            batches = Math.floor(names.length / batchSize);
            log.dbg("DBG: Writing " + names.length + " items in batches of " + batchSize + " a total of " + batches + " times");
            for (i = 0; i < names.length; i += 1) {
              data[names[i]] = operation.output[names[i]];
              if ((i + 1) % batchSize === 0) {
                filename = '';
                if (i > batchSize) {
                  filename = Math.floor((i + 1) / batchSize);
                }
                filename = operation.outputFilename.format([filename],{});
                writeFile(filename, data);
                data = {};
              }
            }
          } else {
            writeFile(filename, operation.output);
          }
        } else {
          process.nextTick(function () {
            callback(null, operation);
          });
        }
      },
      processRead = function (err, data) {
        var loaded = {},
          names = [],
          i = 0;

        if (err && err.code !== 'ENOENT') {
          log.err(err);
        } else {
          if (!err) {
            loaded = JSON.parse(data);

            if (Array.isArray(loaded)) {
              names = loaded;
              loaded = {};
            } else if (typeof loaded === "object" && loaded !== null) {
              names = Object.getOwnPropertyNames(loaded);
            }

            for (i = 0; i < names.length; i += 1) {
              operation.output[names[i]] = loaded[names[i]] || {};
            }
          }
          saveFile();
        }
      },
      loadFile = function () {
        var filename = '';

        if (operation.inputFilename) {
          filename = operation.inputFilename;
          if (filename.indexOf('{0}') > -1) {
            filename = filename.format([batch], {});
          }
          filename = path.resolve('.', filename);
          fs.readFile(filename, { 'encoding': "utf8" }, processRead);
        } else {
          saveFile();
        }
      };
    operation.output = operation.input;
    loadFile();
  },
  operations = [],
  doNextOperation = function (err, operation) {
    "use strict";

    var i,
      nextOperation = {},
      input = {};

    if (err) {
      log.err("ERROR: ", err.message, err);
    } else {
      nextOperation = operations.pop();

      if (operation) {
        input = operation.output;
      }

      if (nextOperation) {
        if (nextOperation.input) {
          if (Array.isArray(nextOperation.input) && nextOperation.input.length > 0) {
            for (i = 0; i < nextOperation.input.length; i += 1) {
              input[nextOperation.input[i]] = input[nextOperation.input[i]] || {};
            }
          } else if (typeof nextOperation.input !== "object" || nextOperation.input === null) {
            log.err('ERROR: input must be an array or object');
            return;
          }
        }

        nextOperation.input = input;
        nextOperation.output = nextOperation.output || {};
        nextOperation.operation = nextOperation.operation || '';
        nextOperation.debug = nextOperation.debug || false;

        switch (nextOperation.operation) {
        case 'download':
          operationDownload(nextOperation, doNextOperation);
          break;
        case 'config':
          operationConfig(nextOperation, doNextOperation);
          break;
        case 'parse':
          operationParse(nextOperation, doNextOperation);
          break;
        case 'geturls':
          operationGetUrls(nextOperation, doNextOperation);
          break;
        case 'filter':
          operationFilter(nextOperation, doNextOperation);
          break;
        case 'tag':
          operationTag(nextOperation, doNextOperation);
          break;
        case 'generate':
          operationGenerate(nextOperation, doNextOperation);
          break;
        case 'IO':
          operationIO(nextOperation, doNextOperation);
          break;
        default:
          process.nextTick(function () {
            nextOperation.output = nextOperation.input;
            log.out("Skipping ", nextOperation.operation);
            doNextOperation(null, nextOperation);
          });
          break;
        }
      } else {
        if (Object.getOwnPropertyNames(input).length > 0) {
          log.out(input);
        }
        process.exit();
      }
    }
  },
  main = function (argc, argv) {
    "use strict";

    if (argc < 3) {
      log.out('usage: %s %s <filename> [batch]', argv[0], argv[1]);
    } else {
      if (argc === 4) {
        batch = argv[3];
      }
      getOperationChain(path.resolve('.', argv[2]), function (err, result) {
        if (err) {
          log.err(err);
        } else {
          operations = result.reverse();
          log.dbg("DBG: Loaded operations", operations);
          process.nextTick(function () {
            doNextOperation(null, null);
          });
        }
      });
    }
  },
  argv = process.argv,
  argc = argv.length;

if (!String.prototype.format) {
  String.prototype.format = function (matches, tags) {
    "use strict";

    return this.replace(/\{(\d+)\}/g, function (match, number) {
      return (matches[number] === '') ? '' : matches[number] || match;
    }).replace(/\{(\w+)\}/g, function (match, tag) {
      return tags[tag] || match;
    });
  };
  log.dbg("DBG: defined format");
}

main(argc, argv);
