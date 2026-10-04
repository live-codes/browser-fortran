"use strict";
(() => {
  // node_modules/js-base64/base64.mjs
  var _hasbtoa = typeof btoa === "function";
  var _hasBuffer = typeof Buffer === "function";
  var _TD = typeof TextDecoder === "function" ? new TextDecoder() : void 0;
  var _TE = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
  var b64ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var b64chs = Array.prototype.slice.call(b64ch);
  var b64tab = ((a) => {
    let tab = {};
    a.forEach((c, i) => tab[c] = i);
    return tab;
  })(b64chs);
  var _fromCC = String.fromCharCode.bind(String);
  var _U8Afrom = typeof Uint8Array.from === "function" ? Uint8Array.from.bind(Uint8Array) : (it) => new Uint8Array(Array.prototype.slice.call(it, 0));
  var _mkUriSafe = (src) => src.replace(/=/g, "").replace(/[+\/]/g, (m0) => m0 == "+" ? "-" : "_");
  var btoaPolyfill = (bin) => {
    let u32, c0, c1, c2, asc = "";
    const pad = bin.length % 3;
    for (let i = 0; i < bin.length; ) {
      if ((c0 = bin.charCodeAt(i++)) > 255 || (c1 = bin.charCodeAt(i++)) > 255 || (c2 = bin.charCodeAt(i++)) > 255)
        throw new TypeError("invalid character found");
      u32 = c0 << 16 | c1 << 8 | c2;
      asc += b64chs[u32 >> 18 & 63] + b64chs[u32 >> 12 & 63] + b64chs[u32 >> 6 & 63] + b64chs[u32 & 63];
    }
    return pad ? asc.slice(0, pad - 3) + "===".substring(pad) : asc;
  };
  var _btoa = _hasbtoa ? (bin) => btoa(bin) : _hasBuffer ? (bin) => Buffer.from(bin, "binary").toString("base64") : btoaPolyfill;
  var _fromUint8Array = _hasBuffer ? (u8a) => Buffer.from(u8a).toString("base64") : (u8a) => {
    const maxargs = 4096;
    let strs = [];
    for (let i = 0, l = u8a.length; i < l; i += maxargs) {
      strs.push(_fromCC.apply(null, u8a.subarray(i, i + maxargs)));
    }
    return _btoa(strs.join(""));
  };
  var cb_utob = (c) => {
    if (c.length < 2) {
      var cc = c.charCodeAt(0);
      return cc < 128 ? c : cc < 2048 ? _fromCC(192 | cc >>> 6) + _fromCC(128 | cc & 63) : _fromCC(224 | cc >>> 12 & 15) + _fromCC(128 | cc >>> 6 & 63) + _fromCC(128 | cc & 63);
    } else {
      var cc = 65536 + (c.charCodeAt(0) - 55296) * 1024 + (c.charCodeAt(1) - 56320);
      return _fromCC(240 | cc >>> 18 & 7) + _fromCC(128 | cc >>> 12 & 63) + _fromCC(128 | cc >>> 6 & 63) + _fromCC(128 | cc & 63);
    }
  };
  var re_utob = /[\uD800-\uDBFF][\uDC00-\uDFFFF]|[^\x00-\x7F]/g;
  var utob = (u) => u.replace(re_utob, cb_utob);
  var _encode = _hasBuffer ? (s) => Buffer.from(s, "utf8").toString("base64") : _TE ? (s) => _fromUint8Array(_TE.encode(s)) : (s) => _btoa(utob(s));
  var encode = (src, urlsafe = false) => urlsafe ? _mkUriSafe(_encode(src)) : _encode(src);

  // src/livecodes/utils/utils.ts
  var toDataUrl = (content, type = "text/javascript") => `data:${type};charset=UTF-8;base64,` + encode(content);
  var createWorkerFromContent = (content) => {
    try {
      return new Worker(toDataUrl(content));
    } catch (e) {
      return new Worker(URL.createObjectURL(new Blob([content], { type: "application/javascript" })));
    }
  };
  var getErrorMessage = (err) => {
    if (err == null)
      return "";
    if (err instanceof Error)
      return err.message;
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
      return err.message;
    }
    return String(err);
  };

  // src/livecodes/services/modules.ts
  var moduleCDNs = [
    "esm.sh",
    "skypack",
    "esm.run",
    "jsdelivr.esm",
    "fastly.jsdelivr.esm",
    "gcore.jsdelivr.esm",
    "testingcf.jsdelivr.esm",
    "jsdelivr.b-cdn.esm",
    "jspm"
  ];
  var npmCDNs = [
    "jsdelivr",
    "fastly.jsdelivr",
    "unpkg",
    "gcore.jsdelivr",
    "testingcf.jsdelivr",
    "jsdelivr.b-cdn",
    "npmcdn"
  ];
  var ghCDNs = [
    "jsdelivr.gh",
    "fastly.jsdelivr.gh",
    "statically",
    "gcore.jsdelivr.gh",
    "testingcf.jsdelivr.gh",
    "jsdelivr.b-cdn.gh"
  ];
  var modulesService = {
    getModuleUrl: (moduleName, {
      isModule = true,
      defaultCDN = "esm.sh",
      external
    } = {}) => {
      moduleName = moduleName.replace(/#nobundle/g, "");
      const addExternalParam = (url) => !external || !url.includes("https://esm.sh") ? url : url.includes("?") ? `${url}&external=${external}` : `${url}?external=${external}`;
      const moduleUrl = getCdnUrl(moduleName, isModule, defaultCDN);
      if (moduleUrl) {
        return addExternalParam(moduleUrl);
      }
      return isModule ? addExternalParam("https://esm.sh/" + moduleName) : "https://cdn.jsdelivr.net/npm/" + moduleName;
    },
    getUrl: (path, cdn) => path.startsWith("http") || path.startsWith("data:") ? path : getCdnUrl(path, false, cdn || getAppCDN()) || path,
    cdnLists: { npm: npmCDNs, module: moduleCDNs, gh: ghCDNs },
    checkCDNs: async (testModule, preferredCDN) => {
      const cdns = [preferredCDN, ...modulesService.cdnLists.npm].filter(Boolean);
      for (const cdn of cdns) {
        try {
          const res = await fetch(modulesService.getUrl(testModule, cdn), {
            method: "HEAD"
          });
          if (res.ok)
            return cdn;
        } catch {
        }
      }
      return modulesService.cdnLists.npm[0];
    }
  };
  var getAppCDN = () => {
    if (globalThis.appCDN)
      return globalThis.appCDN;
    try {
      const url = new URL(location.href);
      return url.searchParams.get("appCDN") || modulesService.cdnLists.npm[0];
    } catch {
      return modulesService.cdnLists.npm[0];
    }
  };
  var getCdnUrl = (modName, isModule, defaultCDN) => {
    const post = isModule && modName.startsWith("unpkg:") ? "?module" : "";
    if (modName.startsWith("gh:")) {
      modName = modName.replace("gh", ghCDNs[0]);
    } else if (!modName.includes(":")) {
      const prefix = defaultCDN || (isModule ? moduleCDNs[0] : npmCDNs[0]);
      modName = prefix + ":" + modName;
    }
    for (const i of TEMPLATES) {
      const [pattern, template] = i;
      if (pattern.test(modName)) {
        return modName.replace(pattern, template) + post;
      }
    }
    return null;
  };
  var TEMPLATES = [
    [/^(esm\.sh:)(.+)/i, "https://esm.sh/$2"],
    [/^(npm:)(.+)/i, "https://esm.sh/$2"],
    [/^(node:)(.+)/i, "https://esm.sh/$2"],
    [/^(jsr:)(.+)/i, "https://esm.sh/jsr/$2"],
    [/^(pr:)(.+)/i, "https://esm.sh/pr/$2"],
    [/^(pkg\.pr\.new:)(.+)/i, "https://esm.sh/pkg.pr.new/$2"],
    [/^(skypack:)(.+)/i, "https://cdn.skypack.dev/$2"],
    [/^(jsdelivr:)(.+)/i, "https://cdn.jsdelivr.net/npm/$2"],
    [/^(fastly\.jsdelivr:)(.+)/i, "https://fastly.jsdelivr.net/npm/$2"],
    [/^(gcore\.jsdelivr:)(.+)/i, "https://gcore.jsdelivr.net/npm/$2"],
    [/^(testingcf\.jsdelivr:)(.+)/i, "https://testingcf.jsdelivr.net/npm/$2"],
    [/^(jsdelivr\.b-cdn:)(.+)/i, "https://jsdelivr.b-cdn.net/npm/$2"],
    [/^(jsdelivr\.gh:)(.+)/i, "https://cdn.jsdelivr.net/gh/$2"],
    [/^(fastly\.jsdelivr\.gh:)(.+)/i, "https://fastly.jsdelivr.net/gh/$2"],
    [/^(gcore\.jsdelivr\.gh:)(.+)/i, "https://gcore.jsdelivr.net/gh/$2"],
    [/^(testingcf\.jsdelivr\.gh:)(.+)/i, "https://testingcf.jsdelivr.net/gh/$2"],
    [/^(jsdelivr\.b-cdn\.gh:)(.+)/i, "https://jsdelivr.b-cdn.net/gh/$2"],
    [/^(statically:)(.+)/i, "https://cdn.statically.io/gh/$2"],
    [/^(esm\.run:)(.+)/i, "https://esm.run/$2"],
    [/^(jsdelivr\.esm:)(.+)/i, "https://cdn.jsdelivr.net/npm/$2/+esm"],
    [/^(fastly\.jsdelivr\.esm:)(.+)/i, "https://fastly.jsdelivr.net/npm/$2/+esm"],
    [/^(gcore\.jsdelivr\.esm:)(.+)/i, "https://gcore.jsdelivr.net/npm/$2/+esm"],
    [/^(testingcf\.jsdelivr\.esm:)(.+)/i, "https://testingcf.jsdelivr.net/npm/$2/+esm"],
    [/^(jsdelivr\.b-cdn\.esm:)(.+)/i, "https://jsdelivr.b-cdn.net/npm/$2/+esm"],
    [/^(jspm:)(.+)/i, "https://jspm.dev/$2"],
    [/^(esbuild:)(.+)/i, "https://esbuild.vercel.app/$2"],
    [/^(bundle\.run:)(.+)/i, "https://bundle.run/$2"],
    [/^(unpkg:)(.+)/i, "https://unpkg.com/$2"],
    [/^(npmcdn:)(.+)/i, "https://npmcdn.com/$2"],
    [/^(bundlejs:)(.+)/i, "https://deno.bundlejs.com/?file&q=$2"],
    [/^(bundle:)(.+)/i, "https://deno.bundlejs.com/?file&q=$2"],
    [/^(deno:)(.+)/i, "https://deno.bundlejs.com/?file&q=https://deno.land/x/$2/mod.ts"],
    [/^(https:\/\/deno\.land\/.+)/i, "https://deno.bundlejs.com/?file&q=$1"],
    [
      /^(github:|https:\/\/github\.com\/)(.[^\/]+?)\/(.[^\/]+?)\/(?!releases\/)(?:(?:blob|raw)\/)?(.+?\/.+)/i,
      "https://deno.bundlejs.com/?file&q=https://cdn.jsdelivr.net/gh/$2/$3@$4"
    ],
    [/^(gist\.github:)(.+?\/[0-9a-f]+\/raw\/(?:[0-9a-f]+\/)?.+)$/i, "https://gist.githack.com/$2"],
    [
      /^(gitlab:|https:\/\/gitlab\.com\/)([^\/]+.*\/[^\/]+)\/(?:raw|blob)\/(.+?)(?:\?.*)?$/i,
      "https://deno.bundlejs.com/?file&q=https://gl.githack.com/$2/raw/$3"
    ],
    [
      /^(bitbucket:|https:\/\/bitbucket\.org\/)([^\/]+\/[^\/]+)\/(?:raw|src)\/(.+?)(?:\?.*)?$/i,
      "https://deno.bundlejs.com/?file&q=https://bb.githack.com/$2/raw/$3"
    ],
    // snippet file URL from web interface, with revision
    [
      /^(bitbucket:)snippets\/([^\/]+\/[^\/]+)\/revisions\/([^\/\#\?]+)(?:\?[^#]*)?(?:\#file-(.+?))$/i,
      "https://bb.githack.com/!api/2.0/snippets/$2/$3/files/$4"
    ],
    // snippet file URL from web interface, no revision
    [
      /^(bitbucket:)snippets\/([^\/]+\/[^\/\#\?]+)(?:\?[^#]*)?(?:\#file-(.+?))$/i,
      "https://bb.githack.com/!api/2.0/snippets/$2/HEAD/files/$3"
    ],
    // snippet file URLs from REST API
    [
      /^(bitbucket:)\!api\/2.0\/snippets\/([^\/]+\/[^\/]+\/[^\/]+)\/files\/(.+?)(?:\?.*)?$/i,
      "https://bb.githack.com/!api/2.0/snippets/$2/files/$3"
    ],
    [
      /^(api\.bitbucket:)2.0\/snippets\/([^\/]+\/[^\/]+\/[^\/]+)\/files\/(.+?)(?:\?.*)?$/i,
      "https://bb.githack.com/!api/2.0/snippets/$2/files/$3"
    ],
    [/^(rawgit:)(.+?\/[0-9a-f]+\/raw\/(?:[0-9a-f]+\/)?.+)$/i, "https://gist.githack.com/$2"],
    [
      /^(rawgit:|https:\/\/raw\.githubusercontent\.com)(\/[^\/]+\/[^\/]+|[0-9A-Za-z-]+\/[0-9a-f]+\/raw)\/(.+)/i,
      "https://deno.bundlejs.com/?file&q=https://raw.githack.com/$2/$3"
    ]
  ];

  // src/livecodes/vendors.ts
  var { getUrl, getModuleUrl } = modulesService;
  var fortranWasmBaseUrl = /* @__PURE__ */ getUrl("@live-codes/lfortran-wasm@0.1.1/");
  var typescriptVersion = "5.9.3";
  var typescriptUrl = getUrl(`typescript@${typescriptVersion}/lib/typescript.js`);

  // src/livecodes/languages/fortran-wasm/lang-fortran-wasm-script.ts
  var SCRIPT_TYPE = "text/fortran-wasm";
  var getWorkerSrc = () => `
importScripts(${JSON.stringify(fortranWasmBaseUrl + "dist/lfortran-wasm.global.js")});

let compiler = null;

const getCompiler = () => {
  compiler =
    compiler ||
    self.lfortranWasm.createCompiler({
      baseUrl: ${JSON.stringify(fortranWasmBaseUrl + "assets/")},
    });
  return compiler;
};

addEventListener('message', async (event) => {
  const { id, code, input } = event.data;
  try {
    const result = await (await getCompiler()).run(code, input);
    postMessage({
      id,
      result: {
        output: result.stdout,
        // The package reports diagnostics as one rendered string; the runner's contract is a list.
        errors: result.errors ? [result.errors] : [],
        exitCode: result.exitCode,
      },
    });
  } catch (error) {
    postMessage({ id, error: String((error && error.message) || error) });
  }
});

getCompiler().then(
  () => postMessage({ type: 'ready' }),
  (error) => postMessage({ type: 'error', message: String((error && error.message) || error) }),
);
`;
  var createRunner = () => {
    let worker = null;
    let ready = null;
    let settleReady = null;
    let pending = {};
    let nextId = 1;
    const failAll = (error) => {
      for (const id of Object.keys(pending)) {
        pending[Number(id)].reject(error);
      }
      pending = {};
    };
    const teardown = (error) => {
      worker?.terminate();
      worker = null;
      ready = null;
      settleReady?.(error);
      settleReady = null;
      failAll(error);
    };
    const onMessage = (event) => {
      const message = event.data ?? {};
      if (message.type === "ready") {
        settleReady?.();
        settleReady = null;
        return;
      }
      if (message.type === "error") {
        teardown(new Error(message.message));
        return;
      }
      const request = pending[message.id];
      if (!request)
        return;
      delete pending[message.id];
      if (message.error != null) {
        request.reject(new Error(message.error));
      } else {
        request.resolve(message.result);
      }
    };
    const spawn = () => {
      ready = new Promise((resolve, reject) => {
        settleReady = (error) => error ? reject(error) : resolve();
      });
      worker = createWorkerFromContent(getWorkerSrc());
      worker.onmessage = onMessage;
      worker.onerror = (event) => teardown(new Error(`The Fortran worker crashed: ${event.message}`));
    };
    const ensureReady = async () => {
      if (!ready)
        spawn();
      await ready;
    };
    const run = (code, input) => ensureReady().then(
      () => new Promise((resolve, reject) => {
        const id = nextId++;
        pending[id] = { resolve, reject };
        worker?.postMessage({ id, code, input });
      })
    );
    return { ensureReady, run };
  };
  var readCodeOnce = async () => {
    let scripts = Array.from(
      document.querySelectorAll(`script[type="${SCRIPT_TYPE}"]`)
    );
    let source = `type="${SCRIPT_TYPE}"`;
    if (!scripts.length) {
      scripts = Array.from(
        document.querySelectorAll('script[data-livecodes-script="editor"]')
      );
      source = "the editor script marker";
    }
    if (!scripts.length) {
      return { code: "", note: "no program script found on the result page" };
    }
    let code = "";
    let fetched = 0;
    let failed = 0;
    for (const script of scripts) {
      const inline = script.textContent ?? "";
      if (inline.trim()) {
        code += `${inline}
`;
        continue;
      }
      if (script.src) {
        try {
          code += `${await (await fetch(script.src)).text()}
`;
          fetched += 1;
        } catch {
          failed += 1;
        }
      }
    }
    return {
      code,
      note: `found ${scripts.length} script(s) by ${source}, ${fetched} fetched from src, ${failed} src fetch(es) failed`
    };
  };
  var readCode = async (attempts = 10, delayMs = 100) => {
    let last = { code: "", note: "not read yet" };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await readCodeOnce();
      if (last.code.trim()) {
        return last;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return { ...last, note: `${last.note}, after ${attempts} attempts` };
  };
  var setResult = (input, output, error, exitCode) => {
    fortranWasm.input = input;
    fortranWasm.output = output;
    fortranWasm.error = error;
    fortranWasm.exitCode = exitCode;
    fortranWasm.ready = true;
    if (error != null) {
      console.error(error);
    } else if (output != null) {
      console.log(output);
    }
    return { input, output, error, exitCode };
  };
  var _a;
  (_a = window.livecodes).fortran ?? (_a.fortran = {});
  var fortranWasm = window.livecodes.fortran;
  fortranWasm.ready = false;
  fortranWasm.runner ?? (fortranWasm.runner = null);
  var ensureLoaded = (runner) => {
    let init = fortranWasm.init;
    if (!init) {
      init = (async () => {
        parent.postMessage({ type: "loading", payload: true }, "*");
        try {
          await runner.ensureReady();
        } finally {
          parent.postMessage({ type: "loading", payload: false }, "*");
        }
      })().catch((error) => {
        fortranWasm.init = null;
        throw error;
      });
      init.catch(() => void 0);
      fortranWasm.init = init;
    }
    return init;
  };
  fortranWasm.loaded = new Promise((resolve) => {
    const interval = setInterval(() => {
      if (fortranWasm.ready) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
  fortranWasm.run = async (input) => {
    const stdin = `${input ?? fortranWasm.input ?? ""}`;
    const { code, note } = await readCode();
    if (!code.trim()) {
      console.error(`[fortran] no code to run \u2014 ${note}`);
      return setResult(stdin, null, null, null);
    }
    const runner = fortranWasm.runner = fortranWasm.runner || createRunner();
    try {
      await ensureLoaded(runner);
    } catch (error) {
      return setResult(stdin, null, `Error: ${getErrorMessage(error)}`, 1);
    }
    try {
      const result = await runner.run(code, stdin);
      const errors = (result.errors || []).filter(Boolean);
      if (errors.length) {
        return setResult(stdin, null, errors.join("\n"), result.exitCode ?? 1);
      }
      return setResult(stdin, result.output ?? "", null, result.exitCode ?? 0);
    } catch (error) {
      return setResult(stdin, null, `Error: ${getErrorMessage(error)}`, 1);
    }
  };
  window.livecodes.fortran = fortranWasm;
  window.livecodes.f90 = fortranWasm;
  window.addEventListener("load", async () => {
    parent.postMessage({ type: "loading", payload: true }, "*");
    await fortranWasm.run(fortranWasm.input);
    parent.postMessage({ type: "loading", payload: false }, "*");
  });
})();
