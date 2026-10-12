/* ==========================================================================
   SpeakPower downloads: a result as a Word file or a PDF.

   Word: a real .docx built here in the browser (Word's XML parts in a zip),
   so nothing leaves the page and no library is loaded.
   PDF: the same document laid out on its own and handed to the print
   dialog, where "Save as PDF" is the choice (the default on Android Chrome).

   A document is { title, subtitle, sections: [{ heading, lines: [text] }] }.
   Lines keep GRIOT's light formatting: "## " headings, "- " bullets,
   **bold**, and its evidence labels (FACT:, RECOMMENDATION: …) in bold.
   Everything is written as text: in the .docx through XML escaping, in the
   print view through textContent. Nothing is ever parsed as markup.
   ========================================================================== */

(function () {
  "use strict";

  var LABEL = /^(\s*(?:[-*•]\s+)?)(?:\*\*)?(FACT|INFERENCE|HYPOTHESIS|RECOMMENDATION|UNKNOWN)(?:\*\*)?\s*:(?:\*\*)?/i;

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function longDate() {
    try { return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
    catch (e) { return today(); }
  }
  function slug(text) {
    return String(text || "speakpower").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "speakpower";
  }

  // One line of text → a block: its kind and its runs of plain and bold text.
  function parseLine(raw) {
    var line = String(raw).replace(/\s+$/, "");
    if (!line.trim()) return null;
    var kind = "p", m;
    if ((m = line.match(/^\s*#{1,2}\s+(.*)$/))) { kind = "h2"; line = m[1]; }
    else if ((m = line.match(/^\s*#{3,6}\s+(.*)$/))) { kind = "h3"; line = m[1]; }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { kind = "li"; line = m[1]; }
    else if (/^\s*\d+[.)]\s+/.test(line)) { kind = "num"; line = line.trim(); }
    var runs = [];
    var lab = line.match(LABEL);
    if (lab) {
      runs.push({ text: lab[2].toUpperCase() + ":", bold: true });
      line = line.slice(lab[0].length);
    }
    line.split(/(\*\*[^*]+\*\*)/).forEach(function (part) {
      if (!part) return;
      var b = part.match(/^\*\*([^*]+)\*\*$/);
      runs.push(b ? { text: b[1], bold: true } : { text: part.replace(/\*\*/g, ""), bold: false });
    });
    return { kind: kind, runs: runs };
  }

  function blocksOf(doc) {
    var blocks = [{ kind: "title", runs: [{ text: doc.title || "SpeakPower", bold: false }] }];
    if (doc.subtitle) blocks.push({ kind: "subtitle", runs: [{ text: doc.subtitle, bold: false }] });
    blocks.push({ kind: "meta", runs: [{ text: "Prepared with SpeakPower · " + longDate(), bold: false }] });
    (doc.sections || []).forEach(function (s) {
      if (s.heading) blocks.push({ kind: "h1", runs: [{ text: s.heading, bold: false }] });
      (s.lines || []).forEach(function (l) {
        String(l == null ? "" : l).split("\n").forEach(function (one) {
          var b = parseLine(one);
          if (b) blocks.push(b);
        });
      });
    });
    return blocks;
  }

  /* ----------------------------------------------------------- Word (.docx) */

  function xml(text) {
    return String(text)
      // Characters XML 1.0 cannot hold at all.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var STYLE = { title: "Title", subtitle: "Subtitle", meta: "Meta", h1: "Heading1", h2: "Heading2", h3: "Heading3", li: "ListPara", num: "ListPara", p: "Normal" };

  function paragraph(b) {
    var runs = b.runs.slice();
    if (b.kind === "li") runs.unshift({ text: "•\t", bold: false });
    return "<w:p><w:pPr><w:pStyle w:val=\"" + STYLE[b.kind] + "\"/></w:pPr>" +
      runs.map(function (r) {
        return "<w:r>" + (r.bold ? "<w:rPr><w:b/></w:rPr>" : "") +
          "<w:t xml:space=\"preserve\">" + xml(r.text) + "</w:t></w:r>";
      }).join("") + "</w:p>";
  }

  var W = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" " +
          "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"";
  var HEAD = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

  function documentXml(blocks) {
    return HEAD + "<w:document " + W + "><w:body>" + blocks.map(paragraph).join("") +
      "<w:sectPr><w:footerReference w:type=\"default\" r:id=\"rIdFooter\"/>" +
      "<w:pgSz w:w=\"11906\" w:h=\"16838\"/>" +
      "<w:pgMar w:top=\"1300\" w:right=\"1300\" w:bottom=\"1300\" w:left=\"1300\" w:header=\"600\" w:footer=\"600\" w:gutter=\"0\"/>" +
      "</w:sectPr></w:body></w:document>";
  }

  function stylesXml() {
    function style(id, name, rpr, ppr, extra) {
      return "<w:style w:type=\"paragraph\"" + (id === "Normal" ? " w:default=\"1\"" : "") +
        " w:styleId=\"" + id + "\"><w:name w:val=\"" + name + "\"/>" +
        (extra || "") + (ppr ? "<w:pPr>" + ppr + "</w:pPr>" : "") + (rpr ? "<w:rPr>" + rpr + "</w:rPr>" : "") + "</w:style>";
    }
    var navy = "<w:color w:val=\"16233F\"/>";
    var serif = "<w:rFonts w:ascii=\"Georgia\" w:hAnsi=\"Georgia\" w:cs=\"Georgia\"/>";
    return HEAD + "<w:styles " + W + ">" +
      "<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"Calibri\" w:cs=\"Calibri\"/>" +
      "<w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/><w:color w:val=\"1F2937\"/><w:lang w:val=\"en-GB\"/></w:rPr></w:rPrDefault>" +
      "<w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"300\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>" +
      style("Normal", "Normal", "", "", "<w:qFormat/>") +
      style("Title", "Title", serif + navy + "<w:sz w:val=\"44\"/><w:szCs w:val=\"44\"/>", "<w:spacing w:after=\"80\"/>", "<w:basedOn w:val=\"Normal\"/><w:qFormat/>") +
      style("Subtitle", "Subtitle", "<w:i/><w:color w:val=\"4B5563\"/><w:sz w:val=\"24\"/>", "<w:spacing w:after=\"80\"/>", "<w:basedOn w:val=\"Normal\"/>") +
      style("Meta", "Meta", "<w:color w:val=\"7E630F\"/><w:sz w:val=\"18\"/>",
        "<w:spacing w:after=\"240\"/><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"6\" w:color=\"C9A227\"/></w:pBdr>", "<w:basedOn w:val=\"Normal\"/>") +
      style("Heading1", "heading 1", serif + navy + "<w:sz w:val=\"30\"/>", "<w:keepNext/><w:spacing w:before=\"280\" w:after=\"100\"/><w:outlineLvl w:val=\"0\"/>", "<w:basedOn w:val=\"Normal\"/><w:qFormat/>") +
      style("Heading2", "heading 2", navy + "<w:b/><w:sz w:val=\"25\"/>", "<w:keepNext/><w:spacing w:before=\"200\" w:after=\"80\"/><w:outlineLvl w:val=\"1\"/>", "<w:basedOn w:val=\"Normal\"/><w:qFormat/>") +
      style("Heading3", "heading 3", navy + "<w:b/><w:sz w:val=\"22\"/>", "<w:keepNext/><w:spacing w:before=\"160\" w:after=\"60\"/><w:outlineLvl w:val=\"2\"/>", "<w:basedOn w:val=\"Normal\"/>") +
      style("ListPara", "List Paragraph", "", "<w:ind w:left=\"440\" w:hanging=\"300\"/><w:spacing w:after=\"80\"/>", "<w:basedOn w:val=\"Normal\"/>") +
      style("Footer", "footer", "<w:color w:val=\"6B7280\"/><w:sz w:val=\"16\"/>", "<w:jc w:val=\"center\"/>", "<w:basedOn w:val=\"Normal\"/>") +
      "</w:styles>";
  }

  function footerXml(label) {
    return HEAD + "<w:ftr " + W + "><w:p><w:pPr><w:pStyle w:val=\"Footer\"/></w:pPr>" +
      "<w:r><w:t xml:space=\"preserve\">" + xml(label) + " · Page </w:t></w:r>" +
      "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText xml:space=\"preserve\"> PAGE </w:instrText></w:r>" +
      "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType=\"end\"/></w:r>" +
      "</w:p></w:ftr>";
  }

  function coreXml(title) {
    var now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return HEAD + "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" " +
      "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" " +
      "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">" +
      "<dc:title>" + xml(title) + "</dc:title><dc:creator>SpeakPower</dc:creator>" +
      "<dcterms:created xsi:type=\"dcterms:W3CDTF\">" + now + "</dcterms:created>" +
      "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">" + now + "</dcterms:modified></cp:coreProperties>";
  }

  var CT_DOC = "application/vnd.openxmlformats-officedocument.wordprocessingml.";
  function contentTypesXml() {
    return HEAD + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
      "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
      "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
      "<Override PartName=\"/word/document.xml\" ContentType=\"" + CT_DOC + "document.main+xml\"/>" +
      "<Override PartName=\"/word/styles.xml\" ContentType=\"" + CT_DOC + "styles+xml\"/>" +
      "<Override PartName=\"/word/footer1.xml\" ContentType=\"" + CT_DOC + "footer+xml\"/>" +
      "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>" +
      "</Types>";
  }

  var REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
  function rootRels() {
    return HEAD + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
      "<Relationship Id=\"rId1\" Type=\"" + REL + "officeDocument\" Target=\"word/document.xml\"/>" +
      "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>" +
      "</Relationships>";
  }
  function documentRels() {
    return HEAD + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
      "<Relationship Id=\"rIdStyles\" Type=\"" + REL + "styles\" Target=\"styles.xml\"/>" +
      "<Relationship Id=\"rIdFooter\" Type=\"" + REL + "footer\" Target=\"footer1.xml\"/>" +
      "</Relationships>";
  }

  // A zip with stored (uncompressed) entries: all Word needs, in ~40 lines.
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;
    var d = new Date();
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var size = central.reduce(function (n, p) { return n + p.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]),
      { type: CT_DOC + "document" });
  }

  function docxBlob(doc) {
    var blocks = blocksOf(doc);
    return zip([
      { name: "[Content_Types].xml", data: contentTypesXml() },
      { name: "_rels/.rels", data: rootRels() },
      { name: "docProps/core.xml", data: coreXml(doc.title || "SpeakPower") },
      { name: "word/document.xml", data: documentXml(blocks) },
      { name: "word/styles.xml", data: stylesXml() },
      { name: "word/footer1.xml", data: footerXml(doc.footer || "SpeakPower") },
      { name: "word/_rels/document.xml.rels", data: documentRels() }
    ]);
  }

  function save(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function word(doc) {
    save(docxBlob(doc), slug(doc.title) + "-" + today() + ".docx");
  }

  /* -------------------------------------------------------------- PDF (print) */

  var TAG = { title: "h1", subtitle: "p", meta: "p", h1: "h2", h2: "h3", h3: "h4", li: "p", num: "p", p: "p" };

  var pageTitle = null; // the page's own title while a PDF borrows it

  function cleanup() {
    var old = document.getElementById("spPrint");
    if (old) old.remove();
    document.documentElement.classList.remove("sp-printing");
    if (pageTitle !== null) { document.title = pageTitle; pageTitle = null; }
  }

  function pdf(doc) {
    cleanup();
    var host = document.createElement("article");
    host.id = "spPrint";
    host.className = "sp-print";
    var brand = document.createElement("p");
    brand.className = "sp-print-brand";
    brand.textContent = "SpeakPower";
    host.appendChild(brand);
    blocksOf(doc).forEach(function (b) {
      var n = document.createElement(TAG[b.kind]);
      n.className = "sp-print-" + b.kind;
      if (b.kind === "li") n.appendChild(document.createTextNode("• "));
      b.runs.forEach(function (r) {
        if (r.bold) { var s = document.createElement("strong"); s.textContent = r.text; n.appendChild(s); }
        else n.appendChild(document.createTextNode(r.text));
      });
      host.appendChild(n);
    });
    var foot = document.createElement("p");
    foot.className = "sp-print-foot";
    foot.textContent = (doc.footer || "SpeakPower") + " · speakpower-commits.github.io/SpeakPower";
    host.appendChild(foot);
    document.body.appendChild(host);
    document.documentElement.classList.add("sp-printing");
    pageTitle = document.title;
    document.title = slug(doc.title) + "-" + today(); // the PDF's suggested file name
    window.addEventListener("afterprint", function done() {
      window.removeEventListener("afterprint", done);
      cleanup();
    });
    window.print();
    // Browsers that print asynchronously (most phones) still fire afterprint;
    // where none fires, the next download clears the old view and title first.
  }

  // "Download: Word · PDF" for a result. `get` builds the document when
  // clicked, so it always reflects what is on the page at that moment.
  function buttons(get, label) {
    var wrap = document.createElement("span");
    wrap.className = "sp-download";
    var lead = document.createElement("span");
    lead.className = "sp-download-label";
    lead.textContent = (label || "Download") + ":";
    wrap.appendChild(lead);
    [["Word", word, "docx"], ["PDF", pdf, "pdf"]].forEach(function (x) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "sp-download-btn sp-download-btn--" + x[2];
      b.textContent = x[0];
      b.addEventListener("click", function () { x[1](get()); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  window.SPExport = { word: word, pdf: pdf, buttons: buttons, docxBlob: docxBlob, blocksOf: blocksOf };
})();
