var SourceMapConsumer = require('source-map').SourceMapConsumer;
var path = require('path');
var fs = require('fs');

function mapSourcePosition(cache, position) {
  var sourceMap = cache[position.source];
  if (!sourceMap && fs.existsSync(position.source)) {
    // Get the URL of the source map
    var fileData = fs.readFileSync(position.source, 'utf8');
    var match = /\/\/@\s*sourceMappingURL=(.*)\s*$/.exec(fileData);
    if (!match) return position;
    var sourceMappingURL = match[1];

    // Support source map URLs relative to the source URL
    var dir = path.dirname(position.source);
    sourceMappingURL = path.resolve(dir, sourceMappingURL);

    // Parse the source map
    var sourceMap = cache[sourceMappingURL];
    if (!sourceMap && fs.existsSync(sourceMappingURL)) {
      var sourceMapData = fs.readFileSync(sourceMappingURL, 'utf8');
      try {
        sourceMap = new SourceMapConsumer(sourceMapData);
        cache[position.source] = sourceMap;
      } catch (e) {
      }
    }
  }
  return sourceMap ? sourceMap.originalPositionFor(position) : position;
}

// Parses code generated by FormatEvalOrigin(), a function inside V8:
// https://code.google.com/p/v8/source/browse/trunk/src/messages.js
function mapEvalOrigin(cache, origin) {
  // Most eval() calls are in this format
  var match = /^eval at ([^(]+) \((.+):(\d+):(\d+)\)$/.exec(origin);
  if (match) {
    var position = mapSourcePosition(cache, {
      source: match[2],
      line: match[3],
      column: match[4]
    });
    return 'eval at ' + match[1] + ' (' + position.source + ':' +
      position.line + ':' + position.column + ')';
  }

  // Parse nested eval() calls using recursion
  match = /^eval at ([^(]+) \((.+)\)$/.exec(origin);
  if (match) {
    return 'eval at ' + match[1] + ' (' + mapEvalOrigin(cache, match[2]) + ')';
  }

  // Make sure we still return useful information if we didn't find anything
  return origin;
}

function wrapCallSite(cache, frame) {
  // Most call sites will return the source file from getFileName(), but code
  // passed to eval() ending in "//@ sourceURL=..." will return the source file
  // from getScriptNameOrSourceURL() instead
  var source = frame.getFileName() || frame.getScriptNameOrSourceURL();
  if (source) {
    var position = mapSourcePosition(cache, {
      source: source,
      line: frame.getLineNumber(),
      column: frame.getColumnNumber()
    });
    return {
      __proto__: frame,
      getFileName: function() { return position.source; },
      getLineNumber: function() { return position.line; },
      getColumnNumber: function() { return position.column; },
      getScriptNameOrSourceURL: function() { return position.source; }
    };
  }

  // Code called using eval() needs special handling
  var origin = frame.getEvalOrigin();
  if (origin) {
    origin = mapEvalOrigin(cache, origin);
    return {
      __proto__: frame,
      getEvalOrigin: function() { return origin; }
    };
  }

  // If we get here then we were unable to change the source position
  return frame;
}

// This function is part of the V8 stack trace API, for more info see:
// http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
Error.prepareStackTrace = function(error, stack) {
  // Store source maps in a cache so we don't load them more than once when
  // formatting a single stack trace (don't cache them forever though in case
  // the files change on disk and the user wants to see the updated mapping)
  var cache = {};
  return error + stack.map(function(frame) {
    return '\n    at ' + wrapCallSite(cache, frame);
  }).join('');
};

// Mimic node's stack trace printing when an exception escapes the process
process.on('uncaughtException', function(error) {
  if (!error || !error.stack) {
    console.log('Uncaught exception:', error);
    process.exit();
  }
  var match = /\n    at [^(]+ \((.*):(\d+):(\d+)\)/.exec(error.stack);
  if (match) {
    var cache = {};
    var position = mapSourcePosition(cache, {
      source: match[1],
      line: match[2],
      column: match[3]
    });
    if (fs.existsSync(position.source)) {
      var contents = fs.readFileSync(position.source, 'utf8');
      var line = contents.split(/(?:\r\n|\r|\n)/)[position.line - 1];
      if (line) {
        console.log('\n' + position.source + ':' + position.line);
        console.log(line);
        console.log(new Array(+position.column).join(' ') + '^');
      }
    }
  }
  console.log(error.stack);
  process.exit();
});
