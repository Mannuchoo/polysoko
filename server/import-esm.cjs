// Loads an ES module from a CommonJS script.
//
// The services under server/src/services are ES modules and the server is
// ESM too, but the .cjs helper scripts are CommonJS. This is the bridge:
// it imports the ESM module and hands back its namespace.
const { pathToFileURL } = require('url');
const path = require('path');

async function importModule(absolutePath) {
    const resolved = path.isAbsolute(absolutePath)
        ? absolutePath
        : path.join(__dirname, absolutePath);
    return import(pathToFileURL(resolved).href);
}

module.exports = { importModule };
