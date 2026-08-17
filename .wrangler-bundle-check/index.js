var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/partyserver/dist/index.js
import { DurableObject, env } from "cloudflare:workers";

// node_modules/nanoid/url-alphabet/index.js
var urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

// node_modules/nanoid/index.browser.js
var nanoid = /* @__PURE__ */ __name((size = 21) => {
  let id = "";
  let bytes = crypto.getRandomValues(new Uint8Array(size |= 0));
  while (size--) {
    id += urlAlphabet[bytes[size] & 63];
  }
  return id;
}, "nanoid");

// node_modules/partyserver/dist/index.js
if (!("OPEN" in WebSocket)) {
  const WebSocketStatus = {
    CONNECTING: WebSocket.READY_STATE_CONNECTING,
    OPEN: WebSocket.READY_STATE_OPEN,
    CLOSING: WebSocket.READY_STATE_CLOSING,
    CLOSED: WebSocket.READY_STATE_CLOSED
  };
  Object.assign(WebSocket, WebSocketStatus);
  Object.assign(WebSocket.prototype, WebSocketStatus);
}
function tryGetPartyServerMeta(ws) {
  try {
    const attachment = WebSocket.prototype.deserializeAttachment.call(ws);
    if (!attachment || typeof attachment !== "object") return null;
    if (!("__pk" in attachment)) return null;
    const pk = attachment.__pk;
    if (!pk || typeof pk !== "object") return null;
    const { id, tags } = pk;
    if (typeof id !== "string") return null;
    const { uri } = pk;
    return {
      id,
      tags: Array.isArray(tags) ? tags : [],
      uri: typeof uri === "string" ? uri : void 0
    };
  } catch {
    return null;
  }
}
__name(tryGetPartyServerMeta, "tryGetPartyServerMeta");
function isPartyServerWebSocket(ws) {
  return tryGetPartyServerMeta(ws) !== null;
}
__name(isPartyServerWebSocket, "isPartyServerWebSocket");
var AttachmentCache = class {
  static {
    __name(this, "AttachmentCache");
  }
  #cache = /* @__PURE__ */ new WeakMap();
  get(ws) {
    let attachment = this.#cache.get(ws);
    if (!attachment) {
      attachment = WebSocket.prototype.deserializeAttachment.call(ws);
      if (attachment !== void 0) this.#cache.set(ws, attachment);
      else throw new Error("Missing websocket attachment. This is most likely an issue in PartyServer, please open an issue at https://github.com/cloudflare/partykit/issues");
    }
    return attachment;
  }
  set(ws, attachment) {
    this.#cache.set(ws, attachment);
    WebSocket.prototype.serializeAttachment.call(ws, attachment);
  }
};
var attachments = new AttachmentCache();
var connections = /* @__PURE__ */ new WeakSet();
var isWrapped = /* @__PURE__ */ __name((ws) => {
  return connections.has(ws);
}, "isWrapped");
var createLazyConnection = /* @__PURE__ */ __name((ws) => {
  if (isWrapped(ws)) return ws;
  let initialState;
  if ("state" in ws) {
    initialState = ws.state;
    delete ws.state;
  }
  const connection = Object.defineProperties(ws, {
    id: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.id;
      }
    },
    uri: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.uri ?? null;
      }
    },
    tags: {
      configurable: true,
      get() {
        return attachments.get(ws).__pk.tags ?? [];
      }
    },
    socket: {
      configurable: true,
      get() {
        return ws;
      }
    },
    state: {
      configurable: true,
      get() {
        return ws.deserializeAttachment();
      }
    },
    setState: {
      configurable: true,
      value: /* @__PURE__ */ __name(function setState(setState) {
        let state;
        if (setState instanceof Function) state = setState(this.state);
        else state = setState;
        ws.serializeAttachment(state);
        return state;
      }, "setState")
    },
    deserializeAttachment: {
      configurable: true,
      value: /* @__PURE__ */ __name(function deserializeAttachment() {
        return attachments.get(ws).__user ?? null;
      }, "deserializeAttachment")
    },
    serializeAttachment: {
      configurable: true,
      value: /* @__PURE__ */ __name(function serializeAttachment(attachment) {
        const setting = {
          ...attachments.get(ws),
          __user: attachment ?? null
        };
        attachments.set(ws, setting);
      }, "serializeAttachment")
    }
  });
  if (initialState) connection.setState(initialState);
  connections.add(connection);
  return connection;
}, "createLazyConnection");
var HibernatingConnectionIterator = class {
  static {
    __name(this, "HibernatingConnectionIterator");
  }
  index = 0;
  sockets;
  constructor(state, tag) {
    this.state = state;
    this.tag = tag;
  }
  [Symbol.iterator]() {
    return this;
  }
  next() {
    const sockets = this.sockets ?? (this.sockets = this.state.getWebSockets(this.tag));
    let socket;
    while (socket = sockets[this.index++]) if (socket.readyState === WebSocket.READY_STATE_OPEN) {
      if (!isPartyServerWebSocket(socket)) continue;
      return {
        done: false,
        value: createLazyConnection(socket)
      };
    }
    return {
      done: true,
      value: void 0
    };
  }
};
function prepareTags(connectionId, userTags) {
  const tags = [connectionId, ...userTags.filter((t) => t !== connectionId)];
  if (tags.length > 10) throw new Error("A connection can only have 10 tags, including the default id tag.");
  for (const tag of tags) {
    if (typeof tag !== "string") throw new Error(`A connection tag must be a string. Received: ${tag}`);
    if (tag === "") throw new Error("A connection tag must not be an empty string.");
    if (tag.length > 256) throw new Error("A connection tag must not exceed 256 characters");
  }
  return tags;
}
__name(prepareTags, "prepareTags");
var InMemoryConnectionManager = class {
  static {
    __name(this, "InMemoryConnectionManager");
  }
  #connections = /* @__PURE__ */ new Map();
  tags = /* @__PURE__ */ new WeakMap();
  getCount() {
    return this.#connections.size;
  }
  getConnection(id) {
    return this.#connections.get(id);
  }
  *getConnections(tag) {
    if (!tag) {
      yield* this.#connections.values().filter((c) => c.readyState === WebSocket.READY_STATE_OPEN);
      return;
    }
    for (const connection of this.#connections.values()) if ((this.tags.get(connection) ?? []).includes(tag)) yield connection;
  }
  accept(connection, options) {
    try {
      connection.accept({ allowHalfOpen: true });
    } catch {
      connection.accept();
    }
    try {
      connection.binaryType = "arraybuffer";
    } catch {
    }
    const tags = prepareTags(connection.id, options.tags);
    this.#connections.set(connection.id, connection);
    this.tags.set(connection, tags);
    Object.defineProperty(connection, "tags", {
      get: /* @__PURE__ */ __name(() => tags, "get"),
      configurable: true
    });
    const removeConnection = /* @__PURE__ */ __name(() => {
      this.#connections.delete(connection.id);
      connection.removeEventListener("close", removeConnection);
      connection.removeEventListener("error", removeConnection);
    }, "removeConnection");
    connection.addEventListener("close", removeConnection);
    connection.addEventListener("error", removeConnection);
    return connection;
  }
};
var HibernatingConnectionManager = class {
  static {
    __name(this, "HibernatingConnectionManager");
  }
  constructor(controller) {
    this.controller = controller;
  }
  getCount() {
    let count = 0;
    for (const ws of this.controller.getWebSockets()) if (isPartyServerWebSocket(ws)) count++;
    return count;
  }
  getConnection(id) {
    const matching = this.controller.getWebSockets(id).filter((ws) => {
      return tryGetPartyServerMeta(ws)?.id === id;
    });
    if (matching.length === 0) return void 0;
    if (matching.length === 1) return createLazyConnection(matching[0]);
    throw new Error(`More than one connection found for id ${id}. Did you mean to use getConnections(tag) instead?`);
  }
  getConnections(tag) {
    return new HibernatingConnectionIterator(this.controller, tag);
  }
  accept(connection, options) {
    const tags = prepareTags(connection.id, options.tags);
    this.controller.acceptWebSocket(connection, tags);
    connection.serializeAttachment({
      __pk: {
        id: connection.id,
        tags,
        uri: connection.uri ?? void 0
      },
      __user: null
    });
    return createLazyConnection(connection);
  }
};
var CLOSING = 2;
var CLOSED = 3;
function isBenignTeardownError(ws, error) {
  const state = ws.readyState;
  if (state !== CLOSING && state !== CLOSED) return false;
  if (typeof error !== "object" || error === null) return false;
  const typed = error;
  if (typed.retryable === true) return true;
  const message = typeof typed.message === "string" ? typed.message : "";
  return /Network connection lost|WebSocket peer disconnected/i.test(message);
}
__name(isBenignTeardownError, "isBenignTeardownError");
var NAME_STORAGE_KEY = "__ps_name";
function isReservedCloseCode(code) {
  return code === 1005 || code === 1006 || code === 1015;
}
__name(isReservedCloseCode, "isReservedCloseCode");
function closeQuietly(ws, code, reason) {
  if (isReservedCloseCode(code)) return;
  try {
    ws.close(code, reason);
  } catch {
  }
}
__name(closeQuietly, "closeQuietly");
var serverMapCache = /* @__PURE__ */ new WeakMap();
var bindingNameCache = /* @__PURE__ */ new WeakMap();
var DEFAULT_ROUTING_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 800
};
function durableObjectGetOptions(options) {
  return options?.locationHint ? { locationHint: options.locationHint } : void 0;
}
__name(durableObjectGetOptions, "durableObjectGetOptions");
function validatePositiveInteger(value, name) {
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be >= 1`);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
}
__name(validatePositiveInteger, "validatePositiveInteger");
function validatePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
}
__name(validatePositiveNumber, "validatePositiveNumber");
function resolveRoutingRetryOptions(options) {
  if (options === false) return null;
  const resolved = {
    maxAttempts: options?.maxAttempts ?? DEFAULT_ROUTING_RETRY_OPTIONS.maxAttempts,
    baseDelayMs: options?.baseDelayMs ?? DEFAULT_ROUTING_RETRY_OPTIONS.baseDelayMs,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_ROUTING_RETRY_OPTIONS.maxDelayMs,
    onRetry: options?.onRetry
  };
  validatePositiveInteger(resolved.maxAttempts, "routingRetry.maxAttempts");
  validatePositiveNumber(resolved.baseDelayMs, "routingRetry.baseDelayMs");
  validatePositiveNumber(resolved.maxDelayMs, "routingRetry.maxDelayMs");
  if (resolved.baseDelayMs > resolved.maxDelayMs) throw new Error("routingRetry.baseDelayMs must be <= maxDelayMs");
  return resolved;
}
__name(resolveRoutingRetryOptions, "resolveRoutingRetryOptions");
function isRetryableDurableObjectError(error) {
  if (typeof error !== "object" || error === null) return false;
  const typed = error;
  return typed.retryable === true && typed.overloaded !== true;
}
__name(isRetryableDurableObjectError, "isRetryableDurableObjectError");
function routingRetryDelayMs(attempt, options) {
  const upperBoundMs = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * upperBoundMs);
}
__name(routingRetryDelayMs, "routingRetryDelayMs");
async function retryDurableObjectOperation(operation, context, retryOptions) {
  const resolved = resolveRoutingRetryOptions(retryOptions);
  if (!resolved) return await operation();
  let attempt = 1;
  while (true) try {
    return await operation();
  } catch (error) {
    const nextAttempt = attempt + 1;
    if (nextAttempt > resolved.maxAttempts || !isRetryableDurableObjectError(error)) throw error;
    const delayMs = routingRetryDelayMs(attempt, resolved);
    try {
      await resolved.onRetry?.({
        error,
        attempt,
        maxAttempts: resolved.maxAttempts,
        delayMs,
        name: context.name,
        className: context.className
      });
    } catch (callbackError) {
      console.warn("PartyServer routingRetry onRetry callback failed:", callbackError);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt = nextAttempt;
  }
}
__name(retryDurableObjectOperation, "retryDurableObjectOperation");
function encodeProps(props) {
  const bytes = new TextEncoder().encode(JSON.stringify(props));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
__name(encodeProps, "encodeProps");
function decodeProps(header) {
  const trimmed = header.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const binary = atob(header);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}
__name(decodeProps, "decodeProps");
function camelCaseToKebabCase(str) {
  if (str === str.toUpperCase() && str !== str.toLowerCase()) return str.toLowerCase().replace(/_/g, "-");
  let kebabified = str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  kebabified = kebabified.startsWith("-") ? kebabified.slice(1) : kebabified;
  return kebabified.replace(/_/g, "-").replace(/-$/, "");
}
__name(camelCaseToKebabCase, "camelCaseToKebabCase");
function resolveCorsHeaders(cors) {
  if (cors === true) return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400"
  };
  if (cors && typeof cors === "object") {
    const h = new Headers(cors);
    const record = {};
    h.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  return null;
}
__name(resolveCorsHeaders, "resolveCorsHeaders");
async function routePartykitRequest(req, env$1 = env, options) {
  if (!serverMapCache.has(env$1)) {
    const namespaceMap = {};
    const bindingNames2 = {};
    for (const [k, v] of Object.entries(env$1)) if (v && typeof v === "object" && "idFromName" in v && typeof v.idFromName === "function") {
      const kebab = camelCaseToKebabCase(k);
      namespaceMap[kebab] = v;
      bindingNames2[kebab] = k;
    }
    serverMapCache.set(env$1, namespaceMap);
    bindingNameCache.set(env$1, bindingNames2);
  }
  const map = serverMapCache.get(env$1);
  const bindingNames = bindingNameCache.get(env$1);
  const prefixParts = (options?.prefix || "parties").split("/");
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  if (!prefixParts.every((part, index) => parts[index] === part) || parts.length < prefixParts.length + 2) return null;
  const namespace = parts[prefixParts.length];
  const name = parts[prefixParts.length + 1];
  if (name && namespace) {
    let withCorsHeaders = function(response2) {
      if (!corsHeaders || isWebSocket) return response2;
      const newResponse = new Response(response2.body, response2);
      for (const [key, value] of Object.entries(corsHeaders)) newResponse.headers.set(key, value);
      return newResponse;
    };
    __name(withCorsHeaders, "withCorsHeaders");
    if (!map[namespace]) {
      if (namespace === "main") {
        console.warn("You appear to be migrating a PartyKit project to PartyServer.");
        console.warn(`PartyServer doesn't have a "main" party by default. Try adding this to your PartySocket client:
 
party: "${camelCaseToKebabCase(Object.keys(map)[0])}"`);
      } else console.error(`The url ${req.url}  with namespace "${namespace}" and name "${name}" does not match any server namespace. 
Did you forget to add a durable object binding to the class ${namespace[0].toUpperCase() + namespace.slice(1)} in your wrangler.jsonc?`);
      return new Response("Invalid request", { status: 400 });
    }
    const corsHeaders = resolveCorsHeaders(options?.cors);
    const isWebSocket = req.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (req.method === "OPTIONS" && corsHeaders) return new Response(null, { headers: corsHeaders });
    let doNamespace = map[namespace];
    if (options?.jurisdiction) doNamespace = doNamespace.jurisdiction(options.jurisdiction);
    const id = doNamespace.idFromName(name);
    const getOptions = durableObjectGetOptions(options);
    req = new Request(req);
    req.headers.set("x-partykit-namespace", namespace);
    if (options?.jurisdiction) req.headers.set("x-partykit-jurisdiction", options.jurisdiction);
    const className = bindingNames[namespace];
    let partyDeprecationWarned = false;
    const lobby = {
      get party() {
        if (!partyDeprecationWarned) {
          partyDeprecationWarned = true;
          console.warn('lobby.party is deprecated and currently returns the kebab-case namespace (e.g. "my-agent"). Use lobby.className instead to get the Durable Object class name (e.g. "MyAgent"). In the next major version, lobby.party will return the class name.');
        }
        return namespace;
      },
      className,
      name
    };
    if (isWebSocket) {
      if (options?.onBeforeConnect) {
        const reqOrRes = await options.onBeforeConnect(req, lobby);
        if (reqOrRes instanceof Request) req = reqOrRes;
        else if (reqOrRes instanceof Response) return reqOrRes;
      }
    } else if (options?.onBeforeRequest) {
      const reqOrRes = await options.onBeforeRequest(req, lobby);
      if (reqOrRes instanceof Request) req = reqOrRes;
      else if (reqOrRes instanceof Response) return withCorsHeaders(reqOrRes);
    }
    if (options?.props !== void 0) req.headers.set("x-partykit-props", encodeProps(options.props));
    const response = await retryDurableObjectOperation(() => doNamespace.get(id, getOptions).fetch(req.clone()), {
      name,
      className
    }, options?.routingRetry);
    return isWebSocket ? response : withCorsHeaders(response);
  } else return null;
}
__name(routePartykitRequest, "routePartykitRequest");
function resolveServerOptions(serverClass) {
  let current = serverClass;
  while (current) {
    const hibernate = current.options?.hibernate;
    if (hibernate !== void 0) return { hibernate };
    current = Object.getPrototypeOf(current);
  }
  return { hibernate: false };
}
__name(resolveServerOptions, "resolveServerOptions");
var Server = class extends DurableObject {
  static {
    __name(this, "Server");
  }
  static options = { hibernate: false };
  #status = "zero";
  #ParentClass = Object.getPrototypeOf(this).constructor;
  #options = resolveServerOptions(this.#ParentClass);
  #connectionManager = this.#options.hibernate ? new HibernatingConnectionManager(this.ctx) : new InMemoryConnectionManager();
  /**
  * Execute SQL queries against the Server's database
  * @template T Type of the returned rows
  * @param strings SQL query template strings
  * @param values Values to be inserted into the query
  * @returns Array of query results
  */
  sql(strings, ...values) {
    let query = "";
    try {
      query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? "?" : ""), "");
      return [...this.ctx.storage.sql.exec(query, ...values)];
    } catch (e) {
      console.error(`failed to execute sql query: ${query}`, e);
      throw this.onException(e);
    }
  }
  constructor(ctx, env2) {
    super(ctx, env2);
  }
  /**
  * Handle incoming requests to the server.
  */
  async fetch(request) {
    try {
      const props = request.headers.get("x-partykit-props");
      if (props) this.#_props = decodeProps(props);
      if (!this.ctx.id.name && !this.#_name) {
        const room = request.headers.get("x-partykit-room");
        if (room) this.#_name = room;
      }
      await this.#ensureInitialized();
      if (!this.ctx.id.name && !this.#_name) throw new Error(`Cannot determine the name for ${this.#ParentClass.name}: this.ctx.id.name is undefined, no legacy __ps_name storage record is present, and no x-partykit-room header was supplied. Likely causes:
  1. The stub was built via idFromString()/newUniqueId(). PartyServer requires name-based addressing (idFromName/getByName).
  2. The workerd/wrangler runtime is too old to expose ctx.id.name \u2014 update to a recent wrangler release.
  3. You called stub.fetch() directly without going through routePartykitRequest()/getServerByName(). Prefer those, or set the x-partykit-room header.`);
      const url = new URL(request.url);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return await this.onRequest(request);
      else {
        const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair();
        let connectionId = url.searchParams.get("_pk");
        if (!connectionId) connectionId = nanoid();
        let connection = Object.assign(serverWebSocket, {
          id: connectionId,
          uri: request.url,
          server: this.name,
          tags: [],
          state: null,
          setState(setState) {
            let state;
            if (setState instanceof Function) state = setState(this.state);
            else state = setState;
            this.state = state;
            return this.state;
          }
        });
        const ctx = { request };
        const tags = await this.getConnectionTags(connection, ctx);
        connection = this.#connectionManager.accept(connection, { tags });
        if (!this.#options.hibernate) this.#attachSocketEventHandlers(connection);
        await this.onConnect(connection, ctx);
        return new Response(null, {
          status: 101,
          webSocket: clientWebSocket
        });
      }
    } catch (err) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} fetch:`, err);
      if (!(err instanceof Error)) throw err;
      if (request.headers.get("Upgrade") === "websocket") {
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].send(JSON.stringify({ error: err.stack }));
        pair[1].close(1011, "Uncaught exception during session setup");
        return new Response(null, {
          status: 101,
          webSocket: pair[0]
        });
      } else return new Response(err.stack, { status: 500 });
    }
  }
  async webSocketMessage(ws, message) {
    if (!isPartyServerWebSocket(ws)) return;
    try {
      const connection = createLazyConnection(ws);
      await this.#ensureInitialized();
      connection.server = this.name;
      return this.onMessage(connection, message);
    } catch (e) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketMessage:`, e);
    }
  }
  async webSocketClose(ws, code, reason, wasClean) {
    if (!isPartyServerWebSocket(ws)) return;
    try {
      const connection = createLazyConnection(ws);
      await this.#ensureInitialized();
      connection.server = this.name;
      await this.onClose(connection, code, reason, wasClean);
    } catch (e) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketClose:`, e);
    } finally {
      closeQuietly(ws, code, reason);
    }
  }
  async webSocketError(ws, error) {
    if (!isPartyServerWebSocket(ws)) return;
    if (isBenignTeardownError(ws, error)) return;
    try {
      const connection = createLazyConnection(ws);
      await this.#ensureInitialized();
      connection.server = this.name;
      return this.onError(connection, error);
    } catch (e) {
      console.error(`Error in ${this.#ParentClass.name}:${this.ctx.id.name ?? this.#_name ?? "<unnamed>"} webSocketError:`, e);
    }
  }
  /**
  * Read the legacy `__ps_name` storage record as a fallback source of
  * `this.name` when `ctx.id.name` is unavailable. Covers:
  *
  *   1. Alarm handlers firing on alarm records that were scheduled by
  *      a workerd version that did not yet persist `name` into the
  *      alarm record (see the Durable Objects ID docs:
  *      https://developers.cloudflare.com/durable-objects/api/id/#name).
  *      The runtime contract for current workerd populates `ctx.id.name`
  *      in alarm handlers — see the "Raw runtime contract" tests — so
  *      this fallback exists primarily for stale on-disk alarm records
  *      and for defense-in-depth against future runtime changes.
  *   2. Legacy framework-level bootstrap patterns that write
  *      `__ps_name` directly (or call `setName()`) before triggering
  *      `__unsafe_ensureInitialized()` — typically DOs addressed via
  *      `idFromString()` / `newUniqueId()` plus a name override.
  */
  async #hydrateNameFromLegacyStorage() {
    if (this.#_name) return;
    const stored = await this.ctx.storage.get(NAME_STORAGE_KEY);
    if (stored) this.#_name = stored;
  }
  async #persistNameFallbackFromCtxId() {
    const ctxName = this.ctx.id.name;
    if (ctxName === void 0 || this.#_name) return;
    if (await this.ctx.storage.get(NAME_STORAGE_KEY) !== ctxName) await this.ctx.storage.put(NAME_STORAGE_KEY, ctxName);
    this.#_name = ctxName;
  }
  /**
  * @internal — Do not use directly. This is an escape hatch for frameworks
  * (like Agents) that receive calls via native DO RPC, bypassing the
  * standard fetch/alarm/webSocket entry points where initialization
  * normally happens. Calling this from application code is unsupported
  * and may break without notice.
  */
  async __unsafe_ensureInitialized() {
    await this.#ensureInitialized();
  }
  async #ensureInitialized() {
    if (this.#status === "started") return;
    if (this.ctx.id.name !== void 0) await this.#persistNameFallbackFromCtxId();
    else if (!this.#_name) await this.#hydrateNameFromLegacyStorage();
    let error;
    await this.ctx.blockConcurrencyWhile(async () => {
      this.#status = "starting";
      try {
        await this.onStart(this.#_props);
        this.#status = "started";
      } catch (e) {
        this.#status = "zero";
        error = e;
      }
    });
    if (error) throw error;
  }
  #attachSocketEventHandlers(connection) {
    const handleMessageFromClient = /* @__PURE__ */ __name((event) => {
      this.onMessage(connection, event.data)?.catch((e) => {
        console.error("onMessage error:", e);
      });
    }, "handleMessageFromClient");
    const reciprocateClose = /* @__PURE__ */ __name((event) => {
      closeQuietly(connection, event.code, event.reason);
    }, "reciprocateClose");
    const handleCloseFromClient = /* @__PURE__ */ __name((event) => {
      connection.removeEventListener("message", handleMessageFromClient);
      connection.removeEventListener("close", handleCloseFromClient);
      let result;
      try {
        result = this.onClose(connection, event.code, event.reason, event.wasClean);
      } catch (e) {
        console.error("onClose error:", e);
        reciprocateClose(event);
        return;
      }
      if (result && typeof result.then === "function") result.catch((e) => {
        console.error("onClose error:", e);
      }).finally(() => reciprocateClose(event));
      else reciprocateClose(event);
    }, "handleCloseFromClient");
    const handleErrorFromClient = /* @__PURE__ */ __name((e) => {
      connection.removeEventListener("message", handleMessageFromClient);
      connection.removeEventListener("error", handleErrorFromClient);
      if (isBenignTeardownError(connection, e.error)) return;
      this.onError(connection, e.error)?.catch((err) => {
        console.error("onError error:", err);
      });
    }, "handleErrorFromClient");
    connection.addEventListener("close", handleCloseFromClient);
    connection.addEventListener("error", handleErrorFromClient);
    connection.addEventListener("message", handleMessageFromClient);
  }
  #_name;
  /**
  * The name for this server.
  *
  * Resolves from `this.ctx.id.name` — the native DO id name, populated
  * whenever the stub was created via `idFromName()` or `getByName()`.
  * This is available inside every entry point (including the constructor,
  * alarms, and hibernating websocket handlers).
  *
  * For alarm handlers firing on stale on-disk alarm records from
  * older workerd versions that didn't persist `name` into the alarm
  * record, the name is recovered from a storage fallback record.
  *
  * Throws if neither source is available — typically this means the DO
  * was addressed via `idFromString()` or `newUniqueId()`, which is not
  * supported by PartyServer.
  */
  get name() {
    const ctxName = this.ctx.id.name;
    if (ctxName !== void 0) return ctxName;
    if (this.#_name) return this.#_name;
    throw new Error(`Attempting to read .name on ${this.#ParentClass.name}, but this.ctx.id.name is not set and no ${NAME_STORAGE_KEY} fallback record is available. PartyServer requires DOs to be addressed via idFromName()/getByName(), or explicitly bootstrapped with setName() when using idFromString()/newUniqueId(). If this happens in an alarm handler firing on a stale alarm record, initialize the DO from a fetch/RPC entry point first so PartyServer can persist the fallback name.`);
  }
  /**
  * Establish this server's name and trigger `onStart()`.
  *
  * Use cases:
  *
  *   1. **Framework-level bootstrap of DOs where `ctx.id.name` is
  *      undefined** — e.g. DOs addressed via `idFromString()` /
  *      `newUniqueId()`. `setName()` stashes the name in memory and
  *      persists it under `__ps_name` so cold-wake invocations
  *      recover it via `#ensureInitialized()`'s legacy fallback.
  *   2. **Delivering initial `props` to `onStart()`** via the
  *      optional second argument.
  *
  * For DOs addressed via `idFromName()` / `getByName()`, calling
  * `setName()` is redundant — `this.name` is available automatically
  * from `ctx.id.name`. The normal initialization path also persists
  * a fallback record so old-compat alarm handlers can recover the name.
  * Throws if `name` does not match `ctx.id.name`.
  *
  * **Not appropriate for facets.** Cloudflare Agents and any other
  * framework using `ctx.facets.get(...)` should pass an explicit
  * `id` in `FacetStartupOptions` so the facet has its own
  * `ctx.id.name`:
  *
  * ```ts
  * const stub = ctx.facets.get(facetKey, () => ({
  *   class: ChildClass,
  *   id: ctx.exports.SomeBoundDOClass.idFromName(facetName),
  * }));
  * ```
  *
  * Without an explicit `id`, the facet inherits the parent DO's
  * `ctx.id` (including `ctx.id.name`), and `setName()` will throw
  * the ctx.id.name-mismatch error because the facet's intended
  * name differs from the parent's. See
  * https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/
  * for the `FacetStartupOptions.id` semantics.
  *
  * @deprecated for callers that address DOs via `idFromName()` /
  * `getByName()`. Still the supported API for framework-level
  * bootstrap of header/`newUniqueId`-addressed DOs and for
  * delivering initial `props` to `onStart()`.
  */
  async setName(name, props) {
    if (!name) throw new Error("A name is required.");
    const ctxName = this.ctx.id.name;
    if (ctxName !== void 0 && ctxName !== name) throw new Error(`This server's Durable Object id was created for name "${ctxName}", cannot setName to "${name}".`);
    if (this.#_name && this.#_name !== name) throw new Error(`This server already has a name: ${this.#_name}, attempting to set to: ${name}`);
    if (props !== void 0) this.#_props = props;
    if (!this.#_name && ctxName === void 0) {
      await this.ctx.storage.put(NAME_STORAGE_KEY, name);
      this.#_name = name;
    }
    await this.#ensureInitialized();
  }
  /**
  * @internal
  * @deprecated Retained for backward compatibility with older callers.
  * `routePartykitRequest` no longer uses this method; it sends props via
  * the `x-partykit-props` header on the underlying `fetch()` request.
  */
  async _initAndFetch(name, props, request) {
    await this.setName(name, props);
    return this.fetch(request);
  }
  #sendMessageToConnection(connection, message) {
    try {
      connection.send(message);
    } catch (_e) {
      connection.close(1011, "Unexpected error");
    }
  }
  /** Send a message to all connected clients, except connection ids listed in `without` */
  broadcast(msg, without) {
    for (const connection of this.#connectionManager.getConnections()) if (!without || !without.includes(connection.id)) this.#sendMessageToConnection(connection, msg);
  }
  /** Get a connection by connection id */
  getConnection(id) {
    return this.#connectionManager.getConnection(id);
  }
  /**
  * Get all connections. Optionally, you can provide a tag to filter returned connections.
  * Use `Server#getConnectionTags` to tag the connection on connect.
  */
  getConnections(tag) {
    return this.#connectionManager.getConnections(tag);
  }
  /**
  * You can tag a connection to filter them in Server#getConnections.
  * Each connection supports up to 9 tags, each tag max length is 256 characters.
  */
  getConnectionTags(connection, context) {
    return [];
  }
  #_props;
  /**
  * Called when the server is started for the first time.
  */
  onStart(props) {
  }
  /**
  * Called when a new connection is made to the server.
  */
  onConnect(connection, ctx) {
  }
  /**
  * Called when a message is received from a connection.
  */
  onMessage(connection, message) {
  }
  /**
  * Called when a connection is closed.
  */
  onClose(connection, code, reason, wasClean) {
  }
  /**
  * Called when an error occurs on a connection.
  */
  onError(connection, error) {
    console.error(`Error on connection ${connection.id} in ${this.#ParentClass.name}:${this.name}:`, error);
    console.info(`Implement onError on ${this.#ParentClass.name} to handle this error.`);
  }
  /**
  * Called when a request is made to the server.
  */
  onRequest(request) {
    console.warn(`onRequest hasn't been implemented on ${this.#ParentClass.name}:${this.name} responding to ${request.url}`);
    return new Response("Not implemented", { status: 404 });
  }
  /**
  * Called when an exception occurs.
  * @param error - The error that occurred.
  */
  onException(error) {
    console.error(`Exception in ${this.#ParentClass.name}:${this.name}:`, error);
    console.info(`Implement onException on ${this.#ParentClass.name} to handle this error.`);
  }
  onAlarm() {
    console.log(`Implement onAlarm on ${this.#ParentClass.name} to handle alarms.`);
  }
  async alarm() {
    await this.#ensureInitialized();
    await this.onAlarm();
  }
};

// party/netcodec.ts
var NET_MAGIC = 19266;
var NET_VERSION = 1;
var MSG_INPUT = 1;
var MSG_STATE = 2;
var PHASE_COUNTDOWN = 0;
var PHASE_LAUNCH = 1;
var PHASE_RACING = 2;
var PHASE_FINISHED = 3;
var PHASE_TO_ID = {
  countdown: PHASE_COUNTDOWN,
  launch: PHASE_LAUNCH,
  racing: PHASE_RACING,
  finished: PHASE_FINISHED
};
var TYRE_IDS = ["soft", "med", "hard", "ints", "wet"];
function tyreToId(id) {
  const i = TYRE_IDS.indexOf(id || "med");
  return i >= 0 ? i : 1;
}
__name(tyreToId, "tyreToId");
function clampByte(n) {
  return Math.max(0, Math.min(255, n | 0));
}
__name(clampByte, "clampByte");
function quantAngle(a) {
  let x = a % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return Math.max(0, Math.min(65535, Math.round(x / (Math.PI * 2) * 65535)));
}
__name(quantAngle, "quantAngle");
function decodeInput(buf) {
  const v = viewOf(buf);
  if (v.byteLength < 12) return null;
  if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION || v.getUint8(3) !== MSG_INPUT) {
    return null;
  }
  const flags = v.getUint8(4);
  const steer = v.getInt8(5) / 127;
  const throttle = v.getUint8(6) / 255;
  const brake = v.getUint8(7) / 255;
  return {
    input: {
      up: !!(flags & 1),
      down: !!(flags & 2),
      left: !!(flags & 4),
      right: !!(flags & 8),
      ers: !!(flags & 16),
      drs: !!(flags & 32),
      steer,
      throttle,
      brake
    },
    seq: v.getUint16(8, true),
    t: v.getUint16(10, true)
  };
}
__name(decodeInput, "decodeInput");
function encodeState(state, prev = null) {
  const karts = state.karts || [];
  const n = Math.min(6, karts.length);
  const full = !prev || !!state.full || (state.tick & 15) === 0;
  const buf = new ArrayBuffer(24 + n * 56 + 8);
  const v = new DataView(buf);
  let o = 0;
  v.setUint16(o, NET_MAGIC, true);
  o += 2;
  v.setUint8(o++, NET_VERSION);
  v.setUint8(o++, MSG_STATE);
  v.setUint32(o, state.tick >>> 0, true);
  o += 4;
  v.setFloat64(o, state.t, true);
  o += 8;
  let hdrFlags = full ? 1 : 0;
  v.setUint8(o++, hdrFlags);
  v.setUint8(o++, PHASE_TO_ID[state.phase] ?? PHASE_RACING);
  v.setUint8(o++, clampByte(state.countdownVal | 0));
  v.setUint8(o++, n);
  v.setFloat32(o, state.raceTimer || 0, true);
  o += 4;
  for (let i = 0; i < 6; i++) {
    const rpm = state.launchRPM && state.launchRPM[i] || 0;
    v.setUint8(o++, clampByte(Math.round(rpm * 255)));
  }
  for (let i = 0; i < n; i++) {
    const k = karts[i];
    const pk = prev && prev.karts && prev.karts[i];
    let mask = 255;
    if (!full && pk) {
      mask = 1;
      if (k.lap !== pk.lap || k.checkpointsBit !== pk.checkpointsBit || k._nearestSplineIdx !== pk._nearestSplineIdx || Math.abs((k.ersCharge || 0) - (pk.ersCharge || 0)) > 0.02 || Math.abs((k.tyreWear || 0) - (pk.tyreWear || 0)) > 0.01 || k.tyreId !== pk.tyreId || !!k.finished !== !!pk.finished || k.bestLap !== pk.bestLap || Math.abs((k.maxSpeed || 0) - (pk.maxSpeed || 0)) > 1) {
        mask |= 2;
      }
      if (!!k.finished !== !!pk.finished || k.finishTime !== pk.finishTime) mask |= 4;
    } else {
      mask = 7;
    }
    v.setUint8(o++, mask);
    let flags = 0;
    if (k.ersActive) flags |= 1;
    if (k.drsActive) flags |= 2;
    if (k.drsAvailable) flags |= 4;
    if (k.finished) flags |= 8;
    if (k.inPit) flags |= 16;
    if (k.disconnected) flags |= 32;
    v.setUint8(o++, flags);
    v.setInt32(o, Math.round(k.x * 100), true);
    o += 4;
    v.setInt32(o, Math.round(k.y * 100), true);
    o += 4;
    v.setUint16(o, quantAngle(k.angle || 0), true);
    o += 2;
    v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round((k.speed || 0) * 10))), true);
    o += 2;
    if (mask & 2) {
      v.setUint8(o++, clampByte(k.lap || 0));
      v.setUint8(o++, tyreToId(k.tyreId));
      v.setUint8(o++, clampByte(Math.round((k.tyreWear || 0) * 255)));
      v.setUint8(o++, clampByte(Math.round((k.ersCharge || 0) * 255)));
      v.setUint16(o, (k.checkpointsBit || 0) & 65535, true);
      o += 2;
      v.setUint16(o, (k._nearestSplineIdx || 0) & 65535, true);
      o += 2;
      v.setUint16(o, Math.max(0, Math.min(65535, Math.round(k.maxSpeed || 0))), true);
      o += 2;
      const best = k.bestLap != null && isFinite(k.bestLap) ? k.bestLap : 0;
      v.setFloat32(o, best, true);
      o += 4;
      const hasBest = k.bestLap != null && isFinite(k.bestLap) ? 1 : 0;
      v.setUint8(o++, hasBest);
    }
    if (mask & 4) {
      v.setFloat32(o, k.finishTime == null ? -1 : k.finishTime, true);
      o += 4;
    }
  }
  return buf.slice(0, o);
}
__name(encodeState, "encodeState");
function viewOf(buf) {
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}
__name(viewOf, "viewOf");

// sim/constants.ts
var GAME_SPEED_MULT = 0.75;
var GLOBAL_ACCEL_MULT = 0.45;
var COAST_DECEL_PER_SEC = 25;
var SIM_HZ = 60;
var STATE_HZ = 30;
var TYRE_DEFS = [
  { id: "soft", gripBonus: 0.14, speedBonus: 28, dryOnly: true, lifespan: 14 },
  { id: "med", gripBonus: 0.05, speedBonus: 10, dryOnly: true, lifespan: 28 },
  { id: "hard", gripBonus: -0.04, speedBonus: -12, dryOnly: true, lifespan: 55 },
  { id: "ints", gripBonus: 0.08, speedBonus: -5, dryPenalty: true, lifespan: 40 },
  { id: "wet", gripBonus: 0.22, speedBonus: -20, wetOnly: true, dryPenalty: true, lifespan: 40 }
];
var WEATHER_DEFS = [
  { id: "dry", gripMult: 1, speedPen: 0 },
  { id: "drizzle", gripMult: 0.92, speedPen: 0.04 },
  { id: "wet", gripMult: 0.82, speedPen: 0.08 },
  { id: "storm", gripMult: 0.72, speedPen: 0.12 }
];
function normalizeWeatherId(w) {
  const id = String(w || "dry").toLowerCase();
  if (WEATHER_DEFS.some((x) => x.id === id)) return id;
  return "dry";
}
__name(normalizeWeatherId, "normalizeWeatherId");
function isWetWeather(w) {
  const id = normalizeWeatherId(w);
  return id === "drizzle" || id === "wet" || id === "storm";
}
__name(isWetWeather, "isWetWeather");
function getTyre(id) {
  return TYRE_DEFS.find((t) => t.id === id) || TYRE_DEFS[1];
}
__name(getTyre, "getTyre");
function getWeather(id) {
  return WEATHER_DEFS.find((w) => w.id === normalizeWeatherId(id)) || WEATHER_DEFS[0];
}
__name(getWeather, "getWeather");

// sim/math.ts
function splineTangent(spl, idx) {
  const n = spl.length;
  const a = spl[(idx - 1 + n) % n];
  const b = spl[(idx + 1) % n];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
__name(splineTangent, "splineTangent");
function linesCross(ax, ay, bx, by, cx, cy, dx, dy) {
  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }
  __name(cross, "cross");
  const A = { x: ax, y: ay };
  const B = { x: bx, y: by };
  const C = { x: cx, y: cy };
  const D = { x: dx, y: dy };
  return cross(A, B, C) * cross(A, B, D) < 0 && cross(C, D, A) * cross(C, D, B) < 0;
}
__name(linesCross, "linesCross");

// sim/kart.ts
function emptyInput() {
  return { up: false, down: false, left: false, right: false, ers: false, drs: false, steer: 0, throttle: 0, brake: 0 };
}
__name(emptyInput, "emptyInput");
var SimKart = class {
  static {
    __name(this, "SimKart");
  }
  id;
  x;
  y;
  angle;
  speed = 0;
  color;
  getInput;
  maxSpeed = 469 * GAME_SPEED_MULT;
  accel = 296 * GLOBAL_ACCEL_MULT;
  brakeForce = 700;
  friction = 0.9915;
  turnRate = 2.88;
  grip = 1;
  offTrackMaxSpd = 255 * GAME_SPEED_MULT;
  offTrackAccel = 165 * GLOBAL_ACCEL_MULT;
  baseMaxSpeed = 352 * GAME_SPEED_MULT;
  baseTurnRate = 2.88;
  _baseAccel = this.accel;
  _baseBrakeForce = 700;
  _baseGrip = 1;
  isOffTrack = false;
  lap = 0;
  checkpointsBit = 0;
  nextCp = 1;
  lapTimes = [];
  lapStart = null;
  bestLap = Infinity;
  finished = false;
  finishTime = null;
  totalLaps = 3;
  prevX;
  prevY;
  tyreId = "med";
  tyreWear = 0;
  tyreWrongWeather = false;
  inPit = false;
  pitPhase = null;
  ersCharge = 1;
  ersActive = false;
  _ersPrevKey = false;
  _ersToggled = false;
  _ersPower = 0;
  _ersStraightTimer = 0;
  drsAvailable = true;
  drsActive = false;
  drsInZone = false;
  _drsPrevKey = false;
  _drsToggled = false;
  _nearestSplineIdx = 0;
  _throttleAssist = 0;
  _brakeAssist = 0;
  _penaltyTimer = 0;
  _isCompletelyOff = false;
  _onlineDisconnected = false;
  onlineConnId = "";
  onlineName = "";
  simTimeMs = 0;
  constructor(id, x, y, angle, color, getInput) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.color = color;
    this.getInput = getInput;
    this.prevX = x;
    this.prevY = y;
  }
  applySetup(weather, tyreId) {
    this.maxSpeed = 469 * GAME_SPEED_MULT;
    this.accel = 304 * GLOBAL_ACCEL_MULT;
    this.brakeForce = 620;
    this.turnRate = 2.22;
    this.offTrackMaxSpd = 80 * GAME_SPEED_MULT;
    this.grip = 0.78;
    this._baseGrip = this.grip;
    this._baseAccel = this.accel;
    this._baseBrakeForce = this.brakeForce;
    const wx = getWeather(weather);
    const tyre = getTyre(tyreId);
    this.tyreId = tyre.id;
    this.tyreWrongWeather = false;
    const wet = isWetWeather(weather);
    const dry = normalizeWeatherId(weather) === "dry";
    if (dry && tyre.dryPenalty) {
      this.maxSpeed *= 0.38;
      this.turnRate *= 0.45;
      this.grip = Math.min(this.grip, 0.42);
      this.tyreWrongWeather = true;
    } else if (wet && tyre.dryOnly) {
      this.maxSpeed *= 0.42;
      this.turnRate *= 0.4;
      this.grip = Math.min(this.grip, 0.38);
      this.tyreWrongWeather = true;
    } else {
      const g = wx.gripMult + tyre.gripBonus;
      this.maxSpeed = Math.max(100, this.maxSpeed * (1 - wx.speedPen) + tyre.speedBonus);
      this.turnRate *= g;
      this.grip = Math.max(0.35, Math.min(1.15, this.grip * (0.82 + g * 0.22)));
    }
    this._baseGrip = this.grip;
    this.baseMaxSpeed = this.maxSpeed;
    this.baseTurnRate = this.turnRate;
  }
  update(dt, track, otherKarts, contactEnabled, nowMs) {
    if (this.finished) return;
    this.simTimeMs = nowMs;
    const inp = this.getInput() || emptyInput();
    const surfMult = track.surface && track.surface.offTrackMult != null ? track.surface.offTrackMult : 1;
    const applyOff = this.isOffTrack;
    const maxSpd = applyOff ? this.offTrackMaxSpd * surfMult : this.maxSpeed;
    const acc = applyOff ? this.offTrackAccel * surfMult : this.accel;
    let spdLimit = maxSpd;
    if (!this.isOffTrack && otherKarts) {
      let bestWake = 0;
      for (const other of otherKarts) {
        if (other === this || other.finished) continue;
        const dx = other.x - this.x;
        const dy = other.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 600 && dist > 20) {
          const dot = Math.cos(this.angle) * dx + Math.sin(this.angle) * dy;
          if (dot > 0) {
            const lat = Math.abs(-Math.sin(this.angle) * dx + Math.cos(this.angle) * dy);
            const wakeWidth = 18 + dist * 0.22;
            if (lat < wakeWidth) {
              const wakeStrength = Math.max(0, (1 - dist / 600) * (1 - lat / wakeWidth));
              if (wakeStrength > bestWake) bestWake = wakeStrength;
            }
          }
        }
      }
      if (bestWake > 0.08) spdLimit = this.maxSpeed * (1.04 + bestWake * 0.12);
    }
    const hasAnalogDrive = typeof inp.throttle === "number" || typeof inp.brake === "number";
    const throttleTarget = hasAnalogDrive ? Math.max(0, Math.min(1, inp.throttle || 0)) : inp.up ? 1 : 0;
    const brakeTarget = hasAnalogDrive ? Math.max(0, Math.min(1, inp.brake || 0)) : inp.down ? 1 : 0;
    this._throttleAssist += (throttleTarget - this._throttleAssist) * (inp.up ? 0.22 : 0.34);
    this._brakeAssist += (brakeTarget - this._brakeAssist) * (inp.down ? 0.16 : 0.11);
    const throttleInput = Math.max(0, Math.min(1, this._throttleAssist));
    const brakeInput = Math.max(0, Math.min(1, this._brakeAssist));
    if (contactEnabled && otherKarts) {
      const KART_R = 18;
      for (const other of otherKarts) {
        if (other === this || this.id >= other.id || other.finished) continue;
        const dx = this.x - other.x;
        const dy = this.y - other.y;
        const dist = Math.hypot(dx, dy);
        if (dist < KART_R * 2 && dist > 0.1) {
          const pen = KART_R * 2 - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const pushShare = 0.52;
          this.x += nx * pen * pushShare;
          this.y += ny * pen * pushShare;
          other.x -= nx * pen * pushShare;
          other.y -= ny * pen * pushShare;
          const relVx = this.speed * Math.cos(this.angle) - other.speed * Math.cos(other.angle);
          const relVy = this.speed * Math.sin(this.angle) - other.speed * Math.sin(other.angle);
          const relVn = relVx * nx + relVy * ny;
          if (relVn < 0) {
            const impulse = relVn * 0.7;
            this.speed -= impulse * (Math.cos(this.angle) * nx + Math.sin(this.angle) * ny);
            other.speed += impulse * (Math.cos(other.angle) * nx + Math.sin(other.angle) * ny);
            this.speed = Math.max(this.speed, -maxSpd * 0.15);
            other.speed = Math.max(other.speed, -maxSpd * 0.15);
          }
        }
      }
    }
    this.ersActive = !!inp.ers && this.ersCharge > 0 && !this.isOffTrack;
    this._ersPrevKey = !!inp.ers;
    const ersSpdAbs = Math.abs(this.speed);
    const ersSpdRatio = ersSpdAbs / Math.max(1, this.maxSpeed || this.baseMaxSpeed || 1);
    const hasAnalogSteer = typeof inp.steer === "number";
    const ersSteering = hasAnalogSteer ? Math.abs(inp.steer) > 0.12 : !!(inp.left || inp.right);
    if (this.ersActive) {
      this.ersCharge = Math.max(0, this.ersCharge - 1 / 5 * dt);
      if (this.ersCharge <= 0) this.ersActive = false;
      this._ersPower = 1;
      this._ersStraightTimer = 0;
    } else {
      this._ersPower = Math.max(0, (this._ersPower || 0) - 1 / 1.15 * dt);
      let regen = 0;
      if (brakeInput > 0.05 && ersSpdAbs > 18) {
        regen += (0.038 * brakeInput + 0.084 * brakeInput * brakeInput) * (0.45 + ersSpdRatio * 0.55);
      } else if (throttleInput < 0.08 && brakeInput < 0.05 && ersSpdAbs > 12) {
        regen += (throttleInput < 0.02 ? 0.043 : 0.032) * (0.35 + ersSpdRatio * 0.65);
      }
      if (!ersSteering && throttleInput > 0.55 && ersSpdRatio > 0.58 && brakeInput < 0.05) {
        this._ersStraightTimer = (this._ersStraightTimer || 0) + dt;
      } else {
        this._ersStraightTimer = Math.max(0, (this._ersStraightTimer || 0) - dt * 2);
      }
      if (this._ersStraightTimer > 1) {
        regen += 0.014 + Math.min(0.011, (this._ersStraightTimer - 1) * 55e-4);
      }
      if (regen > 0) this.ersCharge = Math.min(1, this.ersCharge + regen * dt);
    }
    const drsInZone = this.inDrsZone(track);
    this.drsInZone = drsInZone;
    this.drsActive = !!inp.drs && drsInZone && this.drsAvailable && !this.isOffTrack;
    this._drsPrevKey = !!inp.drs;
    const ersPower = Math.max(0, Math.min(1, this._ersPower || 0));
    if (ersPower > 1e-3) spdLimit *= 1 + 0.25 * ersPower;
    if (this.drsActive) spdLimit *= 1.15;
    if (this.tyreWear >= 1) spdLimit = Math.min(spdLimit, 125);
    const ersAccMult = 1 + 0.14 * ersPower;
    if (throttleInput > 0.02) {
      this.speed += acc * throttleInput * dt * ersAccMult;
    } else if (brakeInput > 0.02) {
      if (this.speed > 0) this.speed -= this.brakeForce * brakeInput * dt;
      else this.speed -= acc * 0.5 * dt;
    } else if (applyOff) {
      this.speed *= Math.pow(0.96, dt * 60);
      if (Math.abs(this.speed) < 0.5) this.speed = 0;
    } else {
      const coastStep = COAST_DECEL_PER_SEC * dt;
      if (this.speed > 0) this.speed = Math.max(0, this.speed - coastStep);
      else if (this.speed < 0) this.speed = Math.min(0, this.speed + coastStep);
      if (Math.abs(this.speed) < 0.5) this.speed = 0;
    }
    if (this.speed > spdLimit) {
      const over = this.speed - spdLimit;
      this.speed -= Math.min(over, Math.max(over * 2.2 * dt, 10 * dt));
    }
    this.speed = Math.max(-maxSpd * 0.3, this.speed);
    if (Math.abs(this.speed) > 4) {
      const speedRatio = Math.abs(this.speed) / Math.max(1, this.maxSpeed);
      const grip = Math.max(0.35, Math.min(1.25, this.grip == null ? 1 : this.grip));
      const gripFactor = Math.max(0.24, (1 - Math.pow(speedRatio, 1.1) * 0.68) * grip);
      const maxYawRate = this.turnRate * gripFactor;
      const dir = this.speed >= 0 ? 1 : -1;
      let wantYaw = 0;
      if (hasAnalogSteer) {
        wantYaw = this.turnRate * dt * dir * Math.max(-1, Math.min(1, inp.steer));
      } else {
        if (inp.left) wantYaw -= this.turnRate * dt * dir;
        if (inp.right) wantYaw += this.turnRate * dt * dir;
      }
      const maxYaw = maxYawRate * dt;
      this.angle += Math.max(-maxYaw, Math.min(maxYaw, wantYaw));
      if (Math.abs(wantYaw) > maxYaw * 1.15 && speedRatio > 0.58) {
        const scrub = 3e-3 + (speedRatio - 0.58) * 0.012;
        this.speed *= Math.pow(1 - scrub, dt * 60);
      }
    }
    if (!this.tyreWrongWeather) {
      const tDef = getTyre(this.tyreId);
      const distTick = Math.abs(this.speed) * dt;
      const wearRate = 1 / (tDef.lifespan * 4200);
      this.tyreWear = Math.min(1, this.tyreWear + distTick * wearRate);
    }
    const wear = this.tyreWear;
    this.maxSpeed = this.baseMaxSpeed * (1 - wear * 0.35);
    this.turnRate = this.baseTurnRate * (1 - wear * 0.25);
    this.accel = (this._baseAccel || 304 * GLOBAL_ACCEL_MULT) * (1 - wear * 0.18);
    this.brakeForce = (this._baseBrakeForce || 700) * 1;
    this.grip = this._baseGrip * (1 - wear * 0.4);
    this.prevX = this.x;
    this.prevY = this.y;
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
    this.isOffTrack = !this.onTrack(track);
    this.handleOffTrackPenalty(dt, track);
    this.checkCheckpoints(track, nowMs);
  }
  onTrack(td) {
    const hw = td.trackWidth / 2 + 55;
    const spl = td.spline;
    const n = spl.length;
    const curIdx = this._nearestSplineIdx || 0;
    let bestDist = Infinity;
    let bestIdx = curIdx;
    for (let d = -8; d <= 80; d++) {
      const idx = ((curIdx + d) % n + n) % n;
      const dist = Math.hypot(this.x - spl[idx].x, this.y - spl[idx].y);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    }
    this._nearestSplineIdx = bestIdx;
    return bestDist < hw;
  }
  inDrsZone(td) {
    if (!td.drsZones || !td.drsZones.length) return false;
    const idx = this._nearestSplineIdx;
    for (const z of td.drsZones) {
      if (z.sIdx <= z.eIdx) {
        if (idx >= z.sIdx && idx <= z.eIdx) return true;
      } else if (idx >= z.sIdx || idx <= z.eIdx) return true;
    }
    return false;
  }
  handleOffTrackPenalty(dt, track) {
    if (this.finished) return;
    const strictHw = track.trackWidth / 2 + 10;
    const nearP = track.spline[this._nearestSplineIdx || 0];
    this._isCompletelyOff = Math.hypot(this.x - nearP.x, this.y - nearP.y) >= strictHw;
    if (this._isCompletelyOff) {
      this.speed *= Math.pow(0.92, dt * 60);
      if (Math.abs(this.speed) > 100) this.speed = Math.sign(this.speed) * 100;
      this._penaltyTimer += dt;
      if (this._penaltyTimer >= 3) {
        const spl = track.spline;
        const ni = this._nearestSplineIdx || 0;
        this.x = spl[ni].x;
        this.y = spl[ni].y;
        const tang = splineTangent(spl, ni);
        this.angle = Math.atan2(tang.y, tang.x);
        this.speed = 0;
        this._penaltyTimer = 0;
        this._isCompletelyOff = false;
      }
    } else {
      this._penaltyTimer = 0;
      this._isCompletelyOff = false;
    }
  }
  checkCheckpoints(td, nowMs) {
    const cps = td.cpLines || [];
    const numCps = cps.length;
    if (!numCps) return;
    for (let i = 0; i < numCps; i++) {
      const cp = cps[i];
      const crossedMain = linesCross(this.prevX, this.prevY, this.x, this.y, cp.x1, cp.y1, cp.x2, cp.y2);
      if (!crossedMain) continue;
      if (i === 0) {
        const allInterDone = this.nextCp >= numCps;
        if (allInterDone && this.lap >= 0) {
          if (this.lap === 0 && this.lapStart === null) {
            this.lapStart = nowMs;
            this.checkpointsBit = 1;
            this.nextCp = 1;
          } else if (this.lapStart !== null) {
            const lapTime = (nowMs - this.lapStart) / 1e3;
            this.lapTimes.push(lapTime);
            if (lapTime < this.bestLap) this.bestLap = lapTime;
            this.lap++;
            if (Number.isFinite(this.totalLaps) && this.lap >= this.totalLaps) {
              this.finished = true;
              this.finishTime = this.lapTimes.reduce((a, b) => a + b, 0);
            } else {
              this.lapStart = nowMs;
              this.checkpointsBit = 1;
              this.nextCp = 1;
            }
          }
        } else if (this.lapStart === null) {
          this.lapStart = nowMs;
          this.checkpointsBit = 1;
          this.nextCp = 1;
        }
      } else if (i === this.nextCp) {
        this.checkpointsBit |= 1 << i;
        this.nextCp = i + 1;
      }
    }
  }
};

// sim/raceOnline.ts
function gradeLaunch(rpm, optimal = 0.66) {
  const err = Math.abs(rpm - optimal);
  if (rpm > 0.88) return 24;
  if (rpm < 0.3) return 16;
  if (err <= 0.045) return 96;
  if (err <= 0.11) return 78;
  return Math.max(34, 90 - err * 120);
}
__name(gradeLaunch, "gradeLaunch");
function gridSlots(track, count) {
  if (track.gridSlots && track.gridSlots.length >= count) {
    return track.gridSlots.slice(0, count);
  }
  const slots = [];
  const sp = track.startPos;
  const ang = track.startAngle || 0;
  const backX = -Math.cos(ang);
  const backY = -Math.sin(ang);
  const perpX = -Math.sin(ang);
  const perpY = Math.cos(ang);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 2);
    const lane = i % 2 === 0 ? -1 : 1;
    slots.push({
      x: sp.x + backX * 55 * row + perpX * 28 * lane,
      y: sp.y + backY * 55 * row + perpY * 28 * lane,
      a: ang
    });
  }
  return slots;
}
__name(gridSlots, "gridSlots");
var OnlineRaceSim = class {
  static {
    __name(this, "OnlineRaceSim");
  }
  track;
  karts = [];
  phase = "countdown";
  countdownVal = 3;
  countdownTimer = 0;
  raceTimer = 0;
  launchRPM = [];
  launchOptimal = 0.66;
  collisionEnabled = true;
  weather = "dry";
  tyres = "med";
  lapCount = 3;
  simTimeMs = 0;
  tick = 0;
  order = [];
  inputs = /* @__PURE__ */ new Map();
  finishedEmitted = false;
  _stateAcc = 0;
  _prevNet = null;
  constructor(cfg) {
    this.track = cfg.track;
    this.weather = cfg.weather || "dry";
    this.tyres = cfg.tyres || "med";
    this.lapCount = Math.max(1, cfg.laps || 3);
    this.collisionEnabled = cfg.collisionMode !== "nocollision";
    this.order = (cfg.order || []).slice();
    const players = cfg.players || [];
    const count = Math.max(2, Math.min(6, this.order.length || players.length || 2));
    const slots = gridSlots(this.track, count);
    for (let i = 0; i < count; i++) {
      const connId = this.order[i] || players[i]?.id || `slot${i}`;
      const plist = players.find((p) => p.id === connId) || players[i] || { id: connId, name: `P${i + 1}`, color: "#00f5ff" };
      const slot = slots[i] || slots[0];
      const self = this;
      const kart = new SimKart(i, slot.x, slot.y, slot.a, plist.color || "#00f5ff", () => self.inputs.get(connId) || emptyInput());
      kart.onlineConnId = connId;
      kart.onlineName = plist.name || `P${i + 1}`;
      kart.totalLaps = this.lapCount;
      kart.applySetup(this.weather, this.tyres);
      this.karts.push(kart);
      this.launchRPM[i] = 0;
      this.inputs.set(connId, emptyInput());
    }
  }
  setInput(connId, input) {
    this.inputs.set(connId, { ...emptyInput(), ...input });
  }
  markDisconnected(connId) {
    const k = this.karts.find((x) => x.onlineConnId === connId);
    if (k) {
      k._onlineDisconnected = true;
      this.inputs.set(connId, emptyInput());
    }
  }
  /** Advance one physics tick (1/60s). Returns encoded state buffer when due, else null. */
  step(dt = 1 / SIM_HZ) {
    this.simTimeMs += dt * 1e3;
    this.tick++;
    if (this.phase === "countdown") {
      this.countdownTimer += dt;
      this.karts.forEach((k, i) => {
        const inp = this.inputs.get(k.onlineConnId) || emptyInput();
        let rpm = this.launchRPM[i] || 0;
        if (inp.up || (inp.throttle || 0) > 0.2) rpm += 1.15 * dt;
        else rpm -= 0.55 * dt;
        if (inp.down || (inp.brake || 0) > 0.2) rpm -= 0.75 * dt;
        this.launchRPM[i] = Math.max(0, Math.min(1, rpm));
      });
      if (this.countdownTimer >= 1) {
        this.countdownTimer -= 1;
        this.countdownVal--;
        if (this.countdownVal <= 0) this.applyLaunch();
      }
    } else if (this.phase === "racing") {
      this.raceTimer += dt;
      for (const k of this.karts) {
        k.drsAvailable = true;
        if (!k._onlineDisconnected) {
          k.update(dt, this.track, this.karts, this.collisionEnabled, this.simTimeMs);
        }
      }
      if (this.karts.every((k) => k.finished)) {
        this.phase = "finished";
      }
    } else if (this.phase === "finished") {
      this.raceTimer += dt;
    }
    this._stateAcc += dt;
    const stateStep = 1 / STATE_HZ;
    if (this._stateAcc >= stateStep) {
      this._stateAcc %= stateStep;
      return this.buildStatePacket(false);
    }
    return null;
  }
  applyLaunch() {
    this.karts.forEach((k, i) => {
      k.speed = gradeLaunch(this.launchRPM[i] || 0, this.launchOptimal);
    });
    this.phase = "racing";
  }
  buildStatePacket(forceFull) {
    const net = {
      type: "state",
      t: Date.now(),
      tick: this.tick,
      phase: this.phase,
      countdownVal: this.countdownVal,
      raceTimer: this.raceTimer,
      launchRPM: this.launchRPM.slice(),
      karts: this.karts.map((k) => this.serializeKart(k)),
      full: forceFull
    };
    const buf = encodeState(net, forceFull ? null : this._prevNet);
    this._prevNet = net;
    return buf;
  }
  serializeKart(k) {
    return {
      id: k.id,
      x: k.x,
      y: k.y,
      angle: k.angle,
      speed: k.speed,
      lap: k.lap || 0,
      finished: !!k.finished,
      finishTime: k.finishTime == null ? null : k.finishTime,
      tyreId: k.tyreId || "med",
      tyreWear: k.tyreWear || 0,
      ersCharge: k.ersCharge || 0,
      ersActive: !!k.ersActive,
      drsActive: !!k.drsActive,
      drsAvailable: !!k.drsAvailable,
      pitPhase: null,
      inPit: false,
      checkpointsBit: k.checkpointsBit || 0,
      _nearestSplineIdx: k._nearestSplineIdx || 0,
      bestLap: k.bestLap < Infinity ? k.bestLap : null,
      maxSpeed: k.maxSpeed || 0,
      disconnected: !!k._onlineDisconnected
    };
  }
  isFinished() {
    return this.phase === "finished";
  }
};

// party/server.ts
var MAX_PLAYERS = 6;
var SIM_STEP_MS = 1e3 / 60;
function json(data) {
  return JSON.stringify(data);
}
__name(json, "json");
function doCtx(room) {
  return room.ctx;
}
__name(doCtx, "doCtx");
function doEnv(room) {
  return room.env;
}
__name(doEnv, "doEnv");
function isBinary(msg) {
  return typeof msg !== "string";
}
__name(isBinary, "isBinary");
function peekBinaryType(buf) {
  if (buf.byteLength < 4) return 0;
  const v = new DataView(buf);
  if (v.getUint16(0, true) !== NET_MAGIC || v.getUint8(2) !== NET_VERSION) return 0;
  return v.getUint8(3);
}
__name(peekBinaryType, "peekBinaryType");
var KartBlitzRoom = class extends Server {
  static {
    __name(this, "KartBlitzRoom");
  }
  players = /* @__PURE__ */ new Map();
  /** Lobby admin (settings / start / return) — not the physics host. */
  hostId = null;
  phase = "lobby";
  settings = {
    trackId: 0,
    laps: 3,
    weather: "dry",
    collisionMode: "collision",
    tyres: "med"
  };
  raceSim = null;
  _alarmScheduled = false;
  _lastSimWall = 0;
  _simAccMs = 0;
  _raceEndTimer = 0;
  onConnect(conn, _ctx) {
    if (this.players.size >= MAX_PLAYERS) {
      conn.send(json({ type: "error", code: "full", message: "Lobby is full (max 6)." }));
      conn.close(4e3, "full");
      return;
    }
    if (this.phase === "racing") {
      conn.send(json({ type: "error", code: "racing", message: "Race already in progress." }));
      conn.close(4001, "racing");
      return;
    }
    const player = {
      id: conn.id,
      name: "RACER",
      ready: false,
      color: "#00f5ff"
    };
    this.players.set(conn.id, player);
    if (!this.hostId) this.hostId = conn.id;
    conn.send(
      json({
        type: "welcome",
        you: conn.id,
        hostId: this.hostId,
        roomId: this.name,
        settings: this.settings,
        phase: this.phase,
        players: this.roster(),
        authority: "server"
      })
    );
    this.broadcastRoster(conn.id);
    void this.syncDirectory();
  }
  onClose(conn) {
    if (!this.players.has(conn.id)) return;
    const wasHost = this.hostId === conn.id;
    this.players.delete(conn.id);
    if (this.players.size === 0) {
      this.hostId = null;
      this.phase = "lobby";
      this.stopSim();
      this.resetSettings();
      void this.syncDirectory(true);
      return;
    }
    if (this.phase === "racing") {
      if (this.raceSim) this.raceSim.markDisconnected(conn.id);
      if (wasHost) {
        this.hostId = this.roster()[0]?.id ?? null;
      }
      this.broadcast(
        json({
          type: "playerLeft",
          id: conn.id,
          hostId: this.hostId,
          players: this.roster(),
          phase: this.phase
        })
      );
      void this.syncDirectory();
      return;
    }
    if (wasHost) {
      this.hostId = this.roster()[0]?.id ?? null;
    }
    this.broadcast(
      json({
        type: "playerLeft",
        id: conn.id,
        hostId: this.hostId,
        players: this.roster(),
        phase: this.phase
      })
    );
    void this.syncDirectory();
  }
  onMessage(sender, message) {
    if (isBinary(message)) {
      this.handleBinary(sender, message);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const type = String(msg.type || "");
    const player = this.players.get(sender.id);
    if (!player && type !== "hello") return;
    switch (type) {
      case "hello": {
        if (!player) return;
        const name = String(msg.name || "RACER").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "RACER";
        const color = String(msg.color || "#00f5ff").slice(0, 16);
        player.name = name;
        player.color = color;
        this.broadcastRoster();
        void this.syncDirectory();
        break;
      }
      case "ready": {
        if (!player || this.phase !== "lobby") return;
        player.ready = !!msg.ready;
        this.broadcastRoster();
        break;
      }
      case "lobbySettings": {
        if (sender.id !== this.hostId || this.phase !== "lobby") return;
        this.settings = {
          trackId: clampInt(msg.trackId, 0, 64, this.settings.trackId),
          laps: clampInt(msg.laps, 1, 20, this.settings.laps),
          weather: String(msg.weather || this.settings.weather).slice(0, 16),
          collisionMode: String(msg.collisionMode || this.settings.collisionMode).slice(0, 24),
          tyres: String(msg.tyres || this.settings.tyres).slice(0, 12)
        };
        this.broadcast(json({ type: "lobbySettings", settings: this.settings }));
        void this.syncDirectory();
        break;
      }
      case "startRace": {
        if (sender.id !== this.hostId || this.phase !== "lobby") return;
        const readyCount = [...this.players.values()].filter((p) => p.ready).length;
        if (this.players.size < 2 || readyCount < 2) {
          sender.send(
            json({
              type: "error",
              code: "not_ready",
              message: "Need at least 2 ready players to start."
            })
          );
          return;
        }
        if (msg.settings && typeof msg.settings === "object") {
          const s = msg.settings;
          this.settings = {
            trackId: clampInt(s.trackId, 0, 64, this.settings.trackId),
            laps: clampInt(s.laps, 1, 20, this.settings.laps),
            weather: String(s.weather || this.settings.weather).slice(0, 16),
            collisionMode: String(s.collisionMode || this.settings.collisionMode).slice(0, 24),
            tyres: String(s.tyres || this.settings.tyres).slice(0, 12)
          };
        }
        const track = sanitizeTrackBake(msg.trackBake);
        if (!track) {
          sender.send(
            json({
              type: "error",
              code: "no_track",
              message: "Missing track bake for server authority. Update the client."
            })
          );
          return;
        }
        const order = this.roster().map((p) => p.id);
        this.phase = "racing";
        this._raceEndTimer = 0;
        this.raceSim = new OnlineRaceSim({
          track,
          players: this.roster().map((p) => ({ id: p.id, name: p.name, color: p.color })),
          order,
          laps: this.settings.laps,
          weather: this.settings.weather,
          collisionMode: this.settings.collisionMode,
          tyres: this.settings.tyres
        });
        this._lastSimWall = Date.now();
        this._simAccMs = 0;
        this.broadcast(
          json({
            type: "startRace",
            settings: this.settings,
            order,
            players: this.roster(),
            hostId: this.hostId,
            authority: "server"
          })
        );
        const boot = this.raceSim.buildStatePacket(true);
        this.broadcast(boot);
        void this.scheduleAlarm(Date.now() + SIM_STEP_MS);
        void this.syncDirectory(true);
        break;
      }
      case "input": {
        if (this.phase !== "racing" || !this.raceSim) return;
        this.raceSim.setInput(sender.id, normalizeInput(msg.input));
        break;
      }
      case "raceEnded": {
        if (sender.id !== this.hostId && this.phase === "racing") return;
        this.endRaceToLobby();
        break;
      }
      case "returnLobby": {
        if (sender.id !== this.hostId) return;
        this.endRaceToLobby();
        break;
      }
      default:
        break;
    }
  }
  handleBinary(sender, buf) {
    const kind = peekBinaryType(buf);
    if (kind === MSG_INPUT) {
      if (this.phase !== "racing" || !this.raceSim) return;
      const decoded = decodeInput(buf);
      if (!decoded) return;
      this.raceSim.setInput(sender.id, decoded.input);
    }
  }
  async onAlarm() {
    this._alarmScheduled = false;
    if (this.phase !== "racing" || !this.raceSim) return;
    const now = Date.now();
    let elapsed = now - (this._lastSimWall || now);
    this._lastSimWall = now;
    elapsed = Math.min(250, Math.max(0, elapsed));
    this._simAccMs += elapsed;
    let steps = 0;
    while (this._simAccMs >= SIM_STEP_MS && steps < 20) {
      this._simAccMs -= SIM_STEP_MS;
      steps++;
      const packet = this.raceSim.step(SIM_STEP_MS / 1e3);
      if (packet) this.broadcast(packet);
    }
    if (this.raceSim.isFinished()) {
      this._raceEndTimer += elapsed;
      if (this._raceEndTimer > 2800) {
        this.broadcast(
          json({
            type: "raceEnded",
            hostId: this.hostId,
            players: this.roster()
          })
        );
        this.stopSim();
        this.phase = "lobby";
        for (const p of this.players.values()) p.ready = false;
        void this.syncDirectory();
        return;
      }
    }
    await this.scheduleAlarm(Date.now() + SIM_STEP_MS);
  }
  async scheduleAlarm(when) {
    try {
      await doCtx(this).storage.setAlarm(when);
      this._alarmScheduled = true;
    } catch (e) {
      console.error("setAlarm failed", e);
    }
  }
  stopSim() {
    this.raceSim = null;
    this._simAccMs = 0;
    this._raceEndTimer = 0;
    this._alarmScheduled = false;
    try {
      void doCtx(this).storage.deleteAlarm();
    } catch {
    }
  }
  endRaceToLobby() {
    this.stopSim();
    this.phase = "lobby";
    for (const p of this.players.values()) p.ready = false;
    this.broadcast(
      json({
        type: "lobby",
        hostId: this.hostId,
        settings: this.settings,
        players: this.roster()
      })
    );
    void this.syncDirectory();
  }
  roster() {
    return [...this.players.values()];
  }
  broadcastRoster(exceptId) {
    const payload = json({
      type: "roster",
      hostId: this.hostId,
      players: this.roster(),
      settings: this.settings,
      phase: this.phase,
      authority: "server"
    });
    if (exceptId) this.broadcast(payload, [exceptId]);
    else this.broadcast(payload);
  }
  resetSettings() {
    this.settings = {
      trackId: 0,
      laps: 3,
      weather: "dry",
      collisionMode: "collision",
      tyres: "med"
    };
  }
  async syncDirectory(forceRemove = false) {
    try {
      const env2 = doEnv(this);
      const dirId = env2.LobbyDirectory.idFromName("global");
      const stub = env2.LobbyDirectory.get(dirId);
      const hostPlayer = this.hostId ? this.players.get(this.hostId) : null;
      const remove = forceRemove || this.players.size === 0 || this.phase === "racing" || this.players.size >= MAX_PLAYERS;
      if (remove) {
        await stub.fetch("https://directory/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: this.name })
        });
        return;
      }
      await stub.fetch("https://directory/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: this.name,
          hostName: hostPlayer?.name || "HOST",
          players: this.players.size,
          max: MAX_PLAYERS,
          trackId: this.settings.trackId,
          laps: this.settings.laps,
          phase: this.phase
        })
      });
    } catch (e) {
      console.error("syncDirectory failed", e);
    }
  }
};
function clampInt(v, min, max, fallback) {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
__name(clampInt, "clampInt");
function normalizeInput(inp) {
  const i = inp || {};
  return {
    up: !!i.up,
    down: !!i.down,
    left: !!i.left,
    right: !!i.right,
    ers: !!i.ers,
    drs: !!i.drs,
    steer: typeof i.steer === "number" ? i.steer : i.left ? -1 : i.right ? 1 : 0,
    throttle: typeof i.throttle === "number" ? i.throttle : i.up ? 1 : 0,
    brake: typeof i.brake === "number" ? i.brake : i.down ? 1 : 0
  };
}
__name(normalizeInput, "normalizeInput");
function sanitizeTrackBake(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = raw;
  const spline = t.spline;
  const cpLines = t.cpLines;
  const startPos = t.startPos;
  if (!Array.isArray(spline) || spline.length < 16) return null;
  if (!Array.isArray(cpLines) || cpLines.length < 1) return null;
  if (!startPos || !Number.isFinite(startPos.x) || !Number.isFinite(startPos.y)) return null;
  const cleanSpline = spline.slice(0, 4e3).map((p) => {
    const pt = p;
    return { x: Number(pt.x) || 0, y: Number(pt.y) || 0 };
  }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (cleanSpline.length < 16) return null;
  const cum = Array.isArray(t.cum) && t.cum.length === cleanSpline.length ? t.cum.map((n) => Number(n) || 0) : buildCum(cleanSpline);
  return {
    id: typeof t.id === "number" ? t.id : 0,
    trackWidth: Math.max(40, Math.min(400, Number(t.trackWidth) || 160)),
    spline: cleanSpline,
    cum,
    totalLen: Number(t.totalLen) || cum[cum.length - 1] || 1,
    startPos: { x: startPos.x, y: startPos.y },
    startAngle: Number(t.startAngle) || 0,
    cpLines: cpLines.slice(0, 32).map((c) => ({
      x1: Number(c.x1) || 0,
      y1: Number(c.y1) || 0,
      x2: Number(c.x2) || 0,
      y2: Number(c.y2) || 0
    })),
    drsZones: Array.isArray(t.drsZones) ? t.drsZones.slice(0, 16).map((z) => ({
      sIdx: Number(z.sIdx) || 0,
      eIdx: Number(z.eIdx) || 0
    })) : [],
    gridSlots: Array.isArray(t.gridSlots) ? t.gridSlots.slice(0, 6).map((s) => ({
      x: Number(s.x) || startPos.x,
      y: Number(s.y) || startPos.y,
      a: Number(s.a) || Number(t.startAngle) || 0
    })) : void 0,
    surface: t.surface && typeof t.surface === "object" ? { offTrackMult: Number(t.surface.offTrackMult) || 1 } : { offTrackMult: 1 }
  };
}
__name(sanitizeTrackBake, "sanitizeTrackBake");
function buildCum(spl) {
  const cum = [0];
  for (let i = 1; i < spl.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(spl[i].x - spl[i - 1].x, spl[i].y - spl[i - 1].y));
  }
  return cum;
}
__name(buildCum, "buildCum");

// party/directory.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";
var STORE_KEY = "lobbies";
var LobbyDirectory = class extends DurableObject2 {
  static {
    __name(this, "LobbyDirectory");
  }
  async load() {
    return await this.ctx.storage.get(STORE_KEY) || {};
  }
  async save(map) {
    await this.ctx.storage.put(STORE_KEY, map);
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && (path === "/" || path === "/list")) {
      const map = await this.load();
      const now = Date.now();
      const open = Object.values(map).filter((e) => e.phase === "lobby" && e.players > 0 && e.players < e.max).filter((e) => now - (e.updatedAt || 0) < 5 * 60 * 1e3).sort((a, b) => b.updatedAt - a.updatedAt);
      return Response.json({ lobbies: open });
    }
    if (request.method === "POST" && path === "/upsert") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const id = String(body.id || "").slice(0, 32);
      if (!id) return Response.json({ error: "missing_id" }, { status: 400 });
      const map = await this.load();
      const entry = {
        id,
        hostName: String(body.hostName || "HOST").slice(0, 16),
        players: Math.max(0, Math.min(6, Number(body.players) || 0)),
        max: Math.max(2, Math.min(6, Number(body.max) || 6)),
        trackId: Math.max(0, Number(body.trackId) || 0),
        laps: Math.max(1, Math.min(20, Number(body.laps) || 3)),
        phase: body.phase === "racing" ? "racing" : "lobby",
        updatedAt: Date.now()
      };
      if (entry.phase === "racing" || entry.players <= 0) {
        delete map[id];
      } else {
        map[id] = entry;
      }
      await this.save(map);
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && path === "/remove") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const id = String(body.id || "");
      const map = await this.load();
      delete map[id];
      await this.save(map);
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  }
};

// party/index.ts
function withCors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
__name(withCors, "withCors");
var index_default = {
  async fetch(request, env2) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    const url = new URL(request.url);
    if (url.pathname === "/lobbies" || url.pathname === "/lobbies/") {
      const id = env2.LobbyDirectory.idFromName("global");
      const stub = env2.LobbyDirectory.get(id);
      const res = await stub.fetch("https://directory/list");
      return withCors(res);
    }
    const party = await routePartykitRequest(request, env2);
    if (party) return party;
    return withCors(
      new Response("KartBlitz online \u2014 GET /lobbies or /parties/main/<roomId>", { status: 200 })
    );
  }
};
export {
  KartBlitzRoom,
  LobbyDirectory,
  index_default as default
};
//# sourceMappingURL=index.js.map
