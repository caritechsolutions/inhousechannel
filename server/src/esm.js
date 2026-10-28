'use strict';
// Load an import-free ES module (shared/*.js) into CommonJS without a build step: strip the
// `export` keywords and return the named exports. Only used for the small shared model files;
// they must not contain import statements.
const fs = require('fs');

function loadEsm(file) {
  let src = fs.readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error(`${file}: esm loader cannot handle import statements`);
  const names = [...src.matchAll(/^export (?:function|var|const|let) (\w+)/gm)].map((m) => m[1]);
  src = src.replace(/^export (function|var|const|let) /gm, '$1 ');
  return new Function(`${src}\nreturn { ${names.join(', ')} };`)(); // eslint-disable-line no-new-func
}

module.exports = { loadEsm };
