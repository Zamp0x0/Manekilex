#!/usr/bin/env node
"use strict";
const { termsAlignWithKey } = require("./dictionary-schema");
const d = require("../data/dictionary_core.json");
const mism = [];
for (const [k, e] of Object.entries(d)) {
  if (!termsAlignWithKey(k, e.term)) {
    mism.push({ key: k, term: e.term, short: String(e.short_meaning || "").slice(0, 30) });
  }
}
console.log("term_key_mismatch:", mism.length);
mism.slice(0, 20).forEach((x) => console.log(JSON.stringify(x)));
