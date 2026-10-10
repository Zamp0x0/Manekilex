/**
 * Phase 3: contextual results are cached per (term, context). The same word in a
 * different sentence must not reuse another sentence's meaning; the same sentence
 * (modulo case / spacing) must. Keys carry only hashes, never the sentence itself.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, loadBackground, evalIn, sleep } = require("./helpers/extension-sandbox");

const cfg = loadConfig();

const FINANCE = { sentence: "The bank approved my loan.", sourceType: "web" };
const RIVER = { sentence: "We sat on the bank of the river.", sourceType: "web" };

const RESULT = (meaningHere) => ({
  queryType: "word",
  term: "bank",
  short_meaning: "银行；河岸",
  meaning_here: meaningHere,
  examples: [],
});

test("bank (finance) and bank (river) get different context identities and cache keys", () => {
  assert.notEqual(cfg.zehContextIdentity(FINANCE), cfg.zehContextIdentity(RIVER));
  assert.notEqual(cfg.zehLookupContextHash(FINANCE), cfg.zehLookupContextHash(RIVER));
  const financeKey = cfg.zehContextCacheStorageKey("word", "bank", FINANCE);
  const riverKey = cfg.zehContextCacheStorageKey("word", "bank", RIVER);
  assert.notEqual(financeKey, riverKey);
  assert.notEqual(
    cfg.zehContextDedupKey("word", "bank", FINANCE),
    cfg.zehContextDedupKey("word", "bank", RIVER),
    "in-flight requests are not shared across contexts either"
  );
  // same generic prefix: the term part of the key is unchanged
  const generic = cfg.zehCacheV2StorageKey("word", 4, cfg.zehCacheTextHash("word", "bank"));
  assert.ok(financeKey.startsWith(`${generic}:c`), financeKey);
  assert.match(financeKey, /^zehCache:v2:word:4:[0-9a-f]{8}:c[0-9a-f]{8}$/);
});

test("equivalent context (case / spacing) maps to the same key; nearby text is part of identity", () => {
  const variant = { sentence: "  the  BANK approved\tmy loan. ", sourceType: "iframe" };
  assert.equal(cfg.zehLookupContextHash(variant), cfg.zehLookupContextHash(FINANCE));
  assert.equal(
    cfg.zehContextCacheStorageKey("word", "Bank", variant),
    cfg.zehContextCacheStorageKey("word", "bank", FINANCE),
    "term case and source type do not split the cache"
  );
  const withNearby = { ...FINANCE, nearbyText: "I needed money. The bank approved my loan." };
  assert.notEqual(cfg.zehLookupContextHash(withNearby), cfg.zehLookupContextHash(FINANCE));
  assert.equal(cfg.zehLookupContextHash(null), "");
  assert.equal(cfg.zehLookupContextHash({ sentence: "" }), "");
});

test("cache keys contain no raw sentence text and parse back with their context hash", () => {
  const key = cfg.zehContextCacheStorageKey("word", "bank", RIVER);
  assert.doesNotMatch(key, /river|sat|bank of/i);
  const parsed = cfg.zehParseLookupCacheStorageKey(key);
  assert.equal(parsed.queryType, "word");
  assert.equal(parsed.contextHash, cfg.zehLookupContextHash(RIVER));
  assert.equal(cfg.zehIsLookupCacheStorageKey(key), true);
  assert.equal(cfg.zehClassifyCacheStorageKey(key), "v2");
  assert.equal(cfg.zehParseLookupCacheStorageKey(cfg.zehCacheV2StorageKey("word", 4, "deadbeef")).contextHash, undefined);
});

async function freshBackground() {
  const bg = loadBackground();
  await sleep(20); // let the start-up cache maintenance finish
  return bg;
}

const call = (bg, code) => evalIn(bg.context, code);

test("service worker: a contextual result is reused for the same context only", async () => {
  const bg = await freshBackground();
  bg.context.__ctx = { FINANCE, RIVER, result: RESULT("银行（金融机构）") };
  await call(bg, `setCacheLookup("word", "bank", __ctx.result, { id: "deepseek", model: "m" }, __ctx.FINANCE)`);

  const financeKey = cfg.zehContextCacheStorageKey("word", "bank", FINANCE);
  const stored = bg.local.data[financeKey];
  assert.ok(stored, "written under the contextual key");
  assert.equal(stored.contextHash, cfg.zehLookupContextHash(FINANCE));
  assert.equal(stored.contextIdentity, cfg.zehContextIdentity(FINANCE));
  assert.equal(stored.data.meaning_here, "银行（金融机构）");

  const same = await call(bg, `getCacheLookup("word", "bank", { sentence: "the bank  approved my loan." })`);
  assert.equal(same.data.meaning_here, "银行（金融机构）");
  assert.equal(await call(bg, `getCacheLookup("word", "bank", __ctx.RIVER)`), null, "river must miss");
  assert.equal(await call(bg, `getCacheLookup("word", "bank")`), null, "generic cache is not seeded with a contextual meaning");
});

test("service worker: finance and river results live side by side without overwriting", async () => {
  const bg = await freshBackground();
  bg.context.__ctx = { FINANCE, RIVER, a: RESULT("银行"), b: RESULT("河岸") };
  await call(bg, `setCacheLookup("word", "bank", __ctx.a, {}, __ctx.FINANCE)`);
  await call(bg, `setCacheLookup("word", "bank", __ctx.b, {}, __ctx.RIVER)`);
  assert.equal((await call(bg, `getCacheLookup("word", "bank", __ctx.FINANCE)`)).data.meaning_here, "银行");
  assert.equal((await call(bg, `getCacheLookup("word", "bank", __ctx.RIVER)`)).data.meaning_here, "河岸");
  const contextual = Object.keys(bg.local.data).filter((k) => /:c[0-9a-f]{8}$/.test(k));
  assert.equal(contextual.length, 2);
});

test("service worker: writing a contextual result keeps the generic entry for the same word", async () => {
  const bg = await freshBackground();
  bg.context.__ctx = { FINANCE, generic: { queryType: "word", term: "bank", short_meaning: "银行；河岸" }, a: RESULT("银行") };
  await call(bg, `setCacheLookup("word", "bank", __ctx.generic, { id: "dictionary" })`);
  await call(bg, `setCacheLookup("word", "bank", __ctx.a, {}, __ctx.FINANCE)`);
  await sleep(10);
  const generic = await call(bg, `getCacheLookup("word", "bank")`);
  assert.equal(generic.data.short_meaning, "银行；河岸");
  assert.equal(generic.data.meaning_here, undefined);
});

test("service worker: a hash collision (identity mismatch) is treated as a miss", async () => {
  const bg = await freshBackground();
  bg.context.__ctx = { FINANCE, a: RESULT("银行") };
  await call(bg, `setCacheLookup("word", "bank", __ctx.a, {}, __ctx.FINANCE)`);
  const key = cfg.zehContextCacheStorageKey("word", "bank", FINANCE);
  bg.local.data[key].contextIdentity = "some other sentence\u0000";
  assert.equal(await call(bg, `getCacheLookup("word", "bank", __ctx.FINANCE)`), null);
});

test("service worker: contextual entries expire and are cleaned up like other cache entries", async () => {
  const bg = await freshBackground();
  bg.context.__ctx = { FINANCE, RIVER, a: RESULT("银行"), b: RESULT("河岸") };
  await call(bg, `setCacheLookup("word", "bank", __ctx.a, {}, __ctx.FINANCE)`);
  await call(bg, `setCacheLookup("word", "bank", __ctx.b, {}, __ctx.RIVER)`);
  const financeKey = cfg.zehContextCacheStorageKey("word", "bank", FINANCE);
  const riverKey = cfg.zehContextCacheStorageKey("word", "bank", RIVER);
  const ttl = call(bg, `zehGetCachePolicy("word").ttlMs`);
  bg.local.data[financeKey].createdAt = Date.now() - ttl - 1000;

  const summary = await call(bg, `cleanupLookupCache("manual")`);
  assert.equal(summary.deletedByType.expired, 1);
  assert.equal(bg.local.data[financeKey], undefined, "expired contextual entry removed");
  assert.ok(bg.local.data[riverKey], "fresh contextual entry kept");

  const stats = await call(bg, `getLookupCacheStats()`);
  assert.equal(stats.byType.word, 1, "contextual entries are counted under their query type");

  bg.local.data[riverKey].createdAt = Date.now() - ttl - 1000;
  assert.equal(await call(bg, `getCacheLookup("word", "bank", __ctx.RIVER)`), null, "expired read is a miss");
});
