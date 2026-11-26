/*
  Fonts put into the quotation PDFs themselves, so a quotation looks the same on every phone (the user, 18 Nov: "the
  font is changing based on phone, so lock the font as per word uploaded", then "lock for all quotations"). A PDF that
  only names a font is drawn in whatever the phone's viewer has. Word's fonts belong to Microsoft; each is drawn in
  the free font made to the same letter widths, so lines break where Word breaks them: Calibri → Carlito, Times New
  Roman → Tinos, Arial and Helvetica → Arimo, Cambria → Caladea. Files and licences in public/fonts.
*/
const FONT_BASE = `${String(import.meta.env?.BASE_URL || '/').replace(/\/+$/, '')}/fonts/`;

/** The free font drawn for a Word font's name. */
export const fontFor = (name) => {
  const n = String(name ?? '').toLowerCase();
  if (/cambria/.test(n)) return 'Caladea';
  if (/times|georgia|garamond|antiqua|palatino|bookman|schoolbook|serif/.test(n) && !/sans/.test(n)) return 'Tinos';
  if (/arial|helvetica|verdana|tahoma|segoe|trebuchet|gothic|franklin|open sans|roboto|sans/.test(n)) return 'Arimo';
  return 'Carlito';
};

const fontData = {};
const fontFile = (fam, bold) => {
  const file = `${fam}-${bold ? 'Bold' : 'Regular'}.ttf`;
  fontData[file] ??= fetch(FONT_BASE + file).then((r) => { if (!r.ok) throw new Error(file); return r.arrayBuffer(); }).then((buf) => {
    const u = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  fontData[file].catch(() => { delete fontData[file]; });
  return fontData[file].then((b64) => ({ file, b64 }));
};

/**
  The families given (free names: Tinos, Carlito…), regular and bold, put into the PDF. Returns setFont(fam, bold):
  the family if it came in, else Helvetica, so a font that could not load never stops the PDF.
*/
export async function embedFonts(pdf, families) {
  const have = new Set();
  await Promise.all([...new Set(families)].flatMap((fam) => [false, true].map(async (bold) => {
    try { const { file, b64 } = await fontFile(fam, bold); pdf.addFileToVFS(file, b64); pdf.addFont(file, fam, bold ? 'bold' : 'normal'); have.add(`${fam}/${bold}`); } catch { /* Helvetica stands in */ }
  })));
  return (fam, bold) => {
    if (have.has(`${fam}/${!!bold}`)) pdf.setFont(fam, bold ? 'bold' : 'normal'); else pdf.setFont('helvetica', bold ? 'bold' : 'normal');
  };
}
