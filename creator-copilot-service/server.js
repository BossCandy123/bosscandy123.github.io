"use strict";

const { readFile } = require("node:fs/promises");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createHttpsServer } = require("node:https");
const { createRequestHandler } = require("./src/app");
const { createAiProvider } = require("./src/ai-provider");
const { loadConfig } = require("./src/config");
const { LicenseStore } = require("./src/license-store");

const config = loadConfig();
const store = new LicenseStore({
  filePath: config.dataFile,
  hashSecret: config.licenseHashSecret
});
const provider = createAiProvider(config);
const requestHandler = createRequestHandler({ config, store, provider });
let httpsServer = null;
let httpServer = null;

store
  .initialize()
  .then(async () => {
    const httpsOptions = await loadHttpsOptions(config);
    if (httpsOptions) {
      httpsServer = createHttpsServer(httpsOptions, requestHandler);
      httpServer = createHttpServer((request, response) => redirectToHttps(request, response, config));
      await listen(httpsServer, config.httpsPort);
      await listen(httpServer, config.port);
      console.log(
        `${config.serviceName} listening on https://127.0.0.1:${config.httpsPort} (HTTP redirect on :${config.port})`
      );
    } else {
      httpServer = createHttpServer(requestHandler);
      await listen(httpServer, config.port);
      console.log(`${config.serviceName} listening on http://127.0.0.1:${config.port}`);
    }
    console.log(`AI provider: ${provider.name}`);
    console.log(`OpenAI model: ${provider.model}`);
    if (!config.production) {
      console.log("Development mode is active. Replace all default secrets before deployment.");
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

async function loadHttpsOptions(settings) {
  if (!settings.httpsPfxFile) return null;
  try {
    const pfx = await readFile(settings.httpsPfxFile);
    const passphrase = settings.httpsPfxPassphraseFile
      ? String(await readFile(settings.httpsPfxPassphraseFile, "utf8")).trim()
      : settings.httpsPfxPassphrase;
    return {
      pfx,
      passphrase
    };
  } catch {
    return null;
  }
}

function redirectToHttps(request, response, settings) {
  const host = String(request.headers.host || `127.0.0.1:${settings.port}`).replace(/:\d+$/, "");
  const location = `https://${host}:${settings.httpsPort}${request.url || "/"}`;
  response.writeHead(307, {
    location
  });
  response.end();
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

module.exports = {
  httpServer,
  httpsServer
};
