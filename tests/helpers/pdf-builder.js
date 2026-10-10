/**
 * Small, dependency-free PDF writer for test fixtures.
 *
 * Every PDF the tests and browser checks use is generated here, so the repository carries no
 * third-party documents and every fixture is reproducible from code. Supported:
 *   - text in the standard 14 fonts (Helvetica, Helvetica-Bold, Times-Roman), WinAnsi strings
 *   - several pages of any size, document title (Info dictionary)
 *   - an image-only page (a raw RGB image XObject, no text operators)
 *   - the Standard Security Handler, revision 2 (40-bit RC4), for password-protected fixtures
 *
 * Text is placed with absolute coordinates (PDF user space: origin bottom-left, y up), in the
 * order given. That order is the content-stream order PDF.js reports, which lets a fixture put
 * two columns in an interleaved order on purpose.
 */
const crypto = require("node:crypto");

const FONTS = { F1: "Helvetica", F2: "Helvetica-Bold", F3: "Times-Roman" };

const PASSWORD_PADDING = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex"
);

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts) => crypto.createHash("md5").update(Buffer.concat(parts)).digest();

function padPassword(password) {
  const raw = Buffer.from(String(password || ""), "latin1").subarray(0, 32);
  return Buffer.concat([raw, PASSWORD_PADDING.subarray(0, 32 - raw.length)]);
}

/** Standard Security Handler, V1 / R2 (PDF 1.3, 40-bit key). */
function standardSecurity(userPassword, ownerPassword, fileId) {
  const P = -44; // print + copy allowed, everything else off (bits 1-2 must be 0, 7-8 and 13-32 must be 1)
  const ownerKey = md5(padPassword(ownerPassword || userPassword)).subarray(0, 5);
  const O = rc4(ownerKey, padPassword(userPassword));
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  const key = md5(padPassword(userPassword), O, pBytes, fileId).subarray(0, 5);
  const U = rc4(key, PASSWORD_PADDING);
  return {
    P,
    O,
    U,
    objectKey(num, gen) {
      const n = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
      return md5(key, n).subarray(0, Math.min(key.length + 5, 16));
    },
  };
}

function pdfString(text) {
  return `(${String(text).replace(/[\\()]/g, (c) => `\\${c}`).replace(/\r/g, "\\r").replace(/\n/g, "\\n")})`;
}

function hexString(buf) {
  return `<${Buffer.from(buf).toString("hex")}>`;
}

/** WinAnsi-safe: keep printable Latin-1, map a few typographic characters, drop the rest. */
function winAnsi(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

function textOps(texts) {
  return texts
    .map((t) => {
      const font = t.font || "F1";
      const size = t.size || 11;
      return `BT /${font} ${size} Tf ${t.x} ${t.y} Td ${pdfString(winAnsi(t.text))} Tj ET`;
    })
    .join("\n");
}

/**
 * @param {{
 *   title?: string,
 *   pages: { width?: number, height?: number, texts?: {x,y,text,size?,font?}[], image?: {width:number,height:number,rgb:Buffer,x,y,w,h} }[],
 *   userPassword?: string,
 *   ownerPassword?: string,
 * }} spec
 * @returns {Buffer}
 */
function buildPdf(spec) {
  const pages = spec.pages || [];
  const objects = []; // index = object number - 1; { dict: string, stream?: Buffer }
  const add = (obj) => {
    objects.push(obj);
    return objects.length;
  };

  const catalogNum = add(null);
  const pagesNum = add(null);
  const fontNums = {};
  Object.entries(FONTS).forEach(([name, base]) => {
    fontNums[name] = add({ dict: `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>` });
  });
  const fontRes = Object.entries(fontNums)
    .map(([name, num]) => `/${name} ${num} 0 R`)
    .join(" ");

  const pageNums = [];
  for (const page of pages) {
    const width = page.width || 612;
    const height = page.height || 792;
    let ops = textOps(page.texts || []);
    let xobj = "";
    if (page.image) {
      const im = page.image;
      const imNum = add({
        dict: `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB /BitsPerComponent 8`,
        stream: im.rgb,
      });
      xobj = ` /XObject << /Im1 ${imNum} 0 R >>`;
      ops = `q ${im.w} 0 0 ${im.h} ${im.x} ${im.y} cm /Im1 Do Q\n${ops}`;
    }
    const contentNum = add({ dict: "<<", stream: Buffer.from(ops, "latin1") });
    pageNums.push(
      add({
        dict: `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << ${fontRes} >>${xobj} >> /Contents ${contentNum} 0 R >>`,
      })
    );
  }
  objects[pagesNum - 1] = {
    dict: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`,
  };
  objects[catalogNum - 1] = { dict: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>` };

  const fileId = md5(Buffer.from(JSON.stringify({ title: spec.title || "", pages: pages.length })));
  const security = spec.userPassword != null ? standardSecurity(spec.userPassword, spec.ownerPassword, fileId) : null;

  let infoNum = 0;
  if (spec.title) {
    // Title written as a raw string, encrypted below when the file is protected.
    infoNum = add({ dict: null, title: winAnsi(spec.title) });
  }
  let encryptNum = 0;
  if (security) {
    encryptNum = add({
      dict: `<< /Filter /Standard /V 1 /R 2 /O ${hexString(security.O)} /U ${hexString(security.U)} /P ${security.P} >>`,
      plain: true,
    });
  }

  const chunks = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((obj, i) => {
    const num = i + 1;
    const encrypt = security && !obj.plain ? (data) => rc4(security.objectKey(num, 0), data) : (data) => data;
    let body;
    if (obj.title != null) {
      const title = security ? hexString(encrypt(Buffer.from(obj.title, "latin1"))) : pdfString(obj.title);
      body = Buffer.from(`<< /Title ${title} /Producer (Manekilex test fixture) >>`, "latin1");
    } else if (obj.stream) {
      const data = encrypt(obj.stream);
      const head = obj.dict.endsWith(">>") ? obj.dict.slice(0, -2) : obj.dict;
      body = Buffer.concat([
        Buffer.from(`${head} /Length ${data.length} >>\nstream\n`, "latin1"),
        data,
        Buffer.from("\nendstream", "latin1"),
      ]);
    } else {
      body = Buffer.from(obj.dict, "latin1");
    }
    const chunk = Buffer.concat([Buffer.from(`${num} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    offsets.push(offset);
    chunks.push(chunk);
    offset += chunk.length;
  });

  const xrefStart = offset;
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  offsets.forEach((o) => xref.push(`${String(o).padStart(10, "0")} 00000 n \n`));
  const trailer = [
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R`,
    infoNum ? ` /Info ${infoNum} 0 R` : "",
    encryptNum ? ` /Encrypt ${encryptNum} 0 R` : "",
    ` /ID [${hexString(fileId)} ${hexString(fileId)}] >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref.join("") + trailer, "latin1"));
  return Buffer.concat(chunks);
}

// ── Layout helpers ───────────────────────────────────────────────────────────────────────────

/** Greedy word wrap by an approximate Helvetica advance (0.5 em per character). */
function wrapWords(text, maxWidth, size) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const width = (s) => s.length * size * 0.5;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && width(next) > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Lines of a paragraph as positioned text runs, top to bottom. */
function paragraph(lines, { x, top, size = 11, leading = 14, font = "F1" }) {
  return lines.map((text, i) => ({ x, y: top - i * leading, text, size, font }));
}

module.exports = { buildPdf, wrapWords, paragraph, rc4, standardSecurity };
