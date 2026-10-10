/**
 * A tiny in-memory IndexedDB for book-store.js tests (R-10 / R-12).
 *
 * Supports: open (with onupgradeneeded), createObjectStore(keyPath) + createIndex,
 * transaction(stores, mode) with get / getAll / put / delete / openCursor (store + index),
 * IDBKeyRange.only, request onsuccess / onerror, transaction oncomplete / onerror / onabort.
 * `failPutWith(storeName, errorName)` makes the next put on that store fail, which aborts the
 * transaction like a QuotaExceededError would.
 */
function later(fn) {
  setTimeout(fn, 0);
}

class FakeRequest {
  constructor(transaction) {
    this.transaction = transaction || null;
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class FakeCursor {
  constructor(request, store, entries, index) {
    this._request = request;
    this._store = store;
    this._entries = entries;
    this._index = index;
    this._i = 0;
  }
  get value() {
    return clone(this._entries[this._i]);
  }
  get key() {
    const v = this._entries[this._i];
    return this._index ? v[this._index.keyPath] : v[this._store.keyPath];
  }
  update(value) {
    this._store._put(value, this._request.transaction);
    return new FakeRequest(this._request.transaction);
  }
  delete() {
    this._store._delete(this._entries[this._i][this._store.keyPath], this._request.transaction);
    return new FakeRequest(this._request.transaction);
  }
  continue() {
    this._i++;
    this._store._tx(this._request.transaction).schedule(() => {
      this._request.result = this._i < this._entries.length ? this : null;
      if (this._request.onsuccess) this._request.onsuccess({ target: this._request });
    });
  }
}

/** Structured-clone stand-in: copies plain data, keeps functions / exotic objects (Blob stand-ins) by reference. */
function clone(v) {
  if (v === undefined || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(clone);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) continue;
    out[k] = clone(val);
  }
  return out;
}

class FakeIndex {
  constructor(store, name, keyPath) {
    this.store = store;
    this.name = name;
    this.keyPath = keyPath;
  }
  _matches(range) {
    return [...this.store.records.values()].filter((r) => (range ? range.includes(r[this.keyPath]) : true));
  }
  getAll(range) {
    return this.store._request((tx) => clone(this._matches(range)), tx => tx);
  }
  openCursor(range) {
    const entries = this._matches(range);
    const req = this.store._request(null);
    const cursor = new FakeCursor(req, this.store, entries, this);
    this.store._tx(req.transaction).schedule(() => {
      req.result = entries.length ? cursor : null;
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
}

class FakeStore {
  constructor(db, name, keyPath) {
    this.db = db;
    this.name = name;
    this.keyPath = keyPath;
    this.records = new Map();
    this.indexes = new Map();
    this._currentTx = null;
    this.failNextPut = null;
  }
  createIndex(name, keyPath) {
    const idx = new FakeIndex(this, name, keyPath);
    this.indexes.set(name, idx);
    return idx;
  }
  index(name) {
    const idx = this.indexes.get(name);
    if (!idx || !this._base) return idx;
    const bound = Object.create(idx);
    bound.store = this;
    return bound;
  }
  /** The store as seen by one transaction, so two transactions open at once do not share state. */
  _handle(tx) {
    const handle = Object.create(this);
    handle._base = this;
    handle._currentTx = tx;
    return handle;
  }
  _tx(tx) {
    return tx || this._currentTx;
  }
  _request(compute) {
    const tx = this._currentTx;
    const req = new FakeRequest(tx);
    if (compute) {
      tx.schedule(() => {
        req.result = compute(tx);
        if (req.onsuccess) req.onsuccess({ target: req });
      });
    }
    return req;
  }
  _put(value, tx) {
    const t = this._tx(tx);
    if (t.mode !== "readwrite") throw new DOMException("read only", "ReadOnlyError");
    const req = new FakeRequest(t);
    const base = this._base || this;
    const failure = base.failNextPut;
    base.failNextPut = null;
    t.schedule(() => {
      if (failure) {
        req.error = new DOMException(`fake ${failure}`, failure);
        if (req.onerror) req.onerror({ target: req });
        t.abort(req.error);
        return;
      }
      this.records.set(value[this.keyPath], clone(value));
      req.result = value[this.keyPath];
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  _delete(key, tx) {
    const t = this._tx(tx);
    const req = new FakeRequest(t);
    t.schedule(() => {
      this.records.delete(key);
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
  get(key) {
    return this._request(() => clone(this.records.get(key)));
  }
  getAll() {
    return this._request(() => clone([...this.records.values()]));
  }
  put(value) {
    return this._put(value);
  }
  delete(key) {
    return this._delete(key);
  }
  openCursor() {
    const entries = [...this.records.values()];
    const req = this._request(null);
    const cursor = new FakeCursor(req, this, entries, null);
    req.transaction.schedule(() => {
      req.result = entries.length ? cursor : null;
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._pending = 0;
    this._done = false;
    this._settleScheduled = false;
    names.forEach((n) => (db.stores.get(n)._currentTx = this));
    this._scheduleSettle();
  }
  objectStore(name) {
    if (!this.names.includes(name)) throw new DOMException(`store ${name} not in transaction`, "NotFoundError");
    const store = this.db.stores.get(name);
    store._currentTx = this;
    return store._handle(this);
  }
  schedule(fn) {
    if (this._done) throw new DOMException("transaction finished", "TransactionInactiveError");
    this._pending++;
    later(() => {
      this._pending--;
      if (this._done) return;
      fn();
      this._scheduleSettle();
    });
  }
  _scheduleSettle() {
    if (this._settleScheduled) return;
    this._settleScheduled = true;
    later(() => {
      this._settleScheduled = false;
      if (this._done) return;
      if (this._pending > 0) {
        this._scheduleSettle();
        return;
      }
      this._done = true;
      if (this.oncomplete) this.oncomplete({ target: this });
    });
  }
  abort(error) {
    if (this._done) return;
    this._done = true;
    this.error = error || new DOMException("aborted", "AbortError");
    if (this.onerror) this.onerror({ target: this });
    if (this.onabort) this.onabort({ target: this });
  }
}

class FakeDB {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }
  createObjectStore(name, opts) {
    const store = new FakeStore(this, name, (opts && opts.keyPath) || "id");
    this.stores.set(name, store);
    return store;
  }
  transaction(names, mode) {
    return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode || "readonly");
  }
  close() {}
}

class FakeKeyRange {
  constructor(lower, upper) {
    this.lower = lower;
    this.upper = upper;
  }
  includes(v) {
    return v >= this.lower && v <= this.upper;
  }
  static only(v) {
    return new FakeKeyRange(v, v);
  }
}

function createFakeIndexedDB() {
  const dbs = new Map();
  const indexedDB = {
    open(name, version) {
      const req = new FakeRequest(null);
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (fresh) {
          db = new FakeDB(name, version);
          dbs.set(name, db);
        }
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    _dbs: dbs,
    /** Make the next put on `storeName` fail with `errorName` (default QuotaExceededError). */
    failNextPut(storeName, errorName) {
      const db = [...dbs.values()][0];
      db.stores.get(storeName).failNextPut = errorName || "QuotaExceededError";
    },
    records(storeName) {
      const db = [...dbs.values()][0];
      return db ? [...db.stores.get(storeName).records.values()] : [];
    },
  };
  return { indexedDB, IDBKeyRange: FakeKeyRange };
}

module.exports = { createFakeIndexedDB };
