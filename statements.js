/* Bank statement reading for Classic Four.
   The parsing, balance-chain check, categoriser and transfer detection are IndoYNAB v8's,
   carried over unchanged so its tested behaviour comes along. Four feeds the categoriser
   from the live YNAB 4 budget instead of a Register CSV export (see modelFromBudget). */
(function (root) {
'use strict';
  const MONTH_MAP = {
    jan:1, january:1, januari:1,
    feb:2, february:2, februari:2,
    mar:3, march:3, maret:3,
    apr:4, april:4,
    may:5, mei:5,
    jun:6, june:6, juni:6,
    jul:7, july:7, juli:7,
    aug:8, august:8, agustus:8,
    sep:9, sept:9, september:9,
    oct:10, october:10, oktober:10,
    nov:11, november:11,
    dec:12, december:12, desember:12
  };

  function monthNum(name) {
    return MONTH_MAP[name.toLowerCase()] || null;
  }

  // Parse Indonesian-formatted number: "9.298.995,15" -> 9298995.15, "2.000" -> 2000
  function parseID(s) {
    if (!s) return NaN;
    const cleaned = s.replace(/\./g, '').replace(',', '.');
    return parseFloat(cleaned);
  }

  // Format number with 2 decimal places for YNAB
  function fmtAmount(n) {
    return n.toFixed(2);
  }

  // Format for display: IDR thousands
  function fmtDisplay(n) {
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const whole = Math.floor(abs);
    const cents = Math.round((abs - whole) * 100);
    const wholeStr = whole.toLocaleString('id-ID');
    return sign + 'Rp ' + wholeStr + (cents ? ',' + String(cents).padStart(2, '0') : '');
  }

  function formatDate(iso, fmt) {
    const [y, m, d] = iso.split('-');
    if (fmt === 'us') return `${m}/${d}/${y}`;
    if (fmt === 'eu') return `${d}/${m}/${y}`;
    return iso;
  }

  // Escape a single CSV field
  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /* ---------------------- PDF Text Extraction ---------------------- */
  // Returns flat array of items: { page, x, y (top-origin), w, text }
  // `w` (item width) is required to compute right edges — Bank Jago right-aligns its
  // Amount and Balance columns, so the right edge is the stable anchor, not the left.
  async function extractItems(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const all = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const it of content.items) {
        const str = (it.str || '').trim();
        if (!str) continue;
        const x = it.transform[4];
        const yBottom = it.transform[5];
        const y = viewport.height - yBottom; // top-origin y
        all.push({ page: p, x, y, w: (it.width || 0), text: str });
      }
    }
    return all;
  }

  // Group items into rows by y-coordinate (tolerance in pixels)
  function groupRows(items, tol) {
    const sorted = items.slice().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    const rows = [];
    for (const it of sorted) {
      const last = rows[rows.length - 1];
      if (last && last.page === it.page && Math.abs(it.y - last.y) <= tol) {
        last.items.push(it);
        last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length;
      } else {
        rows.push({ page: it.page, y: it.y, items: [it] });
      }
    }
    for (const r of rows) r.items.sort((a, b) => a.x - b.x);
    return rows;
  }

  // Drop items belonging to rows where isBadRow(joined_text) is true
  function filterBadRows(items, isBadRow, tol) {
    const rows = groupRows(items, tol);
    const dropSet = new WeakSet();
    for (const r of rows) {
      const txt = r.items.map(it => it.text).join(' ');
      if (isBadRow(txt)) {
        for (const it of r.items) dropSet.add(it);
      }
    }
    return items.filter(it => !dropSet.has(it));
  }

  /* ---------------------- Bank Muamalat Parser ---------------------- */
  // Columns (for A4 portrait, width ~594):
  //   Tanggal (date):   x 40 - 130
  //   Uraian (desc):    x 130 - 355
  //   Nominal (amount): x 355 - 455 (includes +/- sign and number)
  //   Saldo Akhir:      x 455 - 560
  function parseMuamalat(items) {
    const COL_DATE_MAX = 130;
    const COL_DESC_MIN = 130;
    const COL_DESC_MAX = 355;
    const COL_AMOUNT_MIN = 355;
    const COL_AMOUNT_MAX = 455;
    const COL_BALANCE_MIN = 455;

    // Drop header/footer rows by text pattern
    const badRow = (txt) => {
      if (/E-statement\s+ini\s+dibuat/.test(txt)) return true;
      if (/Halaman\s+\d+\s+dari\s+\d+/.test(txt)) return true;
      if (txt.includes('Tanggal') && txt.includes('Uraian') && txt.includes('Nominal')) return true;
      if (txt.includes('Laporan') && txt.includes('e-Statement')) return true;
      if (/No\s+Rekening/.test(txt)) return true;
      if (/Ringkasan/.test(txt)) return true;
      if (/Rincian\s+Transaksi/.test(txt)) return true;
      if (/Total\s+Saldo/.test(txt)) return true;
      if (/Periode\s*:/.test(txt)) return true;
      if (/Mata\s+Uang/.test(txt)) return true;
      if (/Jenis\s+Tabungan/.test(txt)) return true;
      return false;
    };
    items = filterBadRows(items, badRow, 3);

    // Group into rows with small tolerance (PDF renders lines close together)
    const rows = groupRows(items, 3);

    // Find "date rows" — rows where the leftmost column contains a full date
    const dateRows = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const left = row.items
        .filter(it => it.x < COL_DATE_MAX)
        .map(it => it.text)
        .join(' ')
        .trim();
      const m = left.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
      if (!m) continue;
      const mon = monthNum(m[2]);
      if (!mon) continue;
      const date = `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      dateRows.push({ idx: i, row, date });
    }

    if (dateRows.length === 0) return [];

    const txs = [];
    for (let i = 0; i < dateRows.length; i++) {
      const cur = dateRows[i];
      const prev = dateRows[i - 1];
      const next = dateRows[i + 1];

      // Band boundaries: mid-y between previous date row and current, and current and next.
      // When crossing pages, confine to same page.
      const prevMid = (prev && prev.row.page === cur.row.page)
        ? (prev.row.y + cur.row.y) / 2
        : -Infinity;
      const nextMid = (next && next.row.page === cur.row.page)
        ? (cur.row.y + next.row.y) / 2
        : Infinity;

      // Collect items in this band on the same page
      const bandItems = items.filter(it =>
        it.page === cur.row.page && it.y > prevMid && it.y <= nextMid
      );

      // Amount: items in amount column on the date row itself
      const amountRowItems = cur.row.items
        .filter(it => it.x >= COL_AMOUNT_MIN && it.x < COL_AMOUNT_MAX)
        .sort((a, b) => a.x - b.x);
      const amountText = amountRowItems.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
      const amountMatch = amountText.match(/^([+\-])\s*([\d.,]+)$/);
      if (!amountMatch) continue; // skip rows that don't have a proper amount (header rows, etc.)
      const signedAmount = (amountMatch[1] === '-' ? -1 : 1) * parseID(amountMatch[2]);

      // Balance: items in balance column on the date row
      const balanceRowItems = cur.row.items
        .filter(it => it.x >= COL_BALANCE_MIN)
        .sort((a, b) => a.x - b.x);
      const balance = parseID(balanceRowItems.map(it => it.text).join(''));

      // Description: everything in description column within the band, plus inline desc on date row
      const descItems = bandItems
        .filter(it => it.x >= COL_DATE_MAX && it.x < COL_DESC_MAX);
      // Include inline desc on date row (if the date line also has some description after date)
      const inlineDesc = cur.row.items
        .filter(it => it.x >= COL_DATE_MAX && it.x < COL_DESC_MAX)
        .map(it => it.text).join(' ');

      // Group desc items by row, sort each row by x, join top-to-bottom
      const descRows = groupRows(descItems, 3);
      const descText = descRows
        .map(r => r.items.map(it => it.text).join(' '))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Derive a rough Payee from the description — first meaningful segment
      let payee = '';
      let memo = descText;
      // A "TRF CHARGE BERSAMA" line is the small companion fee of the transfer right above
      // it. It shares the exact same "Ke kode Bank ###-###-NAME" text as that transfer, so
      // without this check first it would extract the user's own name as payee and get
      // conflated with real me-to-me transfers when categorizing. Route it to its own
      // payee up front so it categorizes independently (via memo keywords, e.g. "charge"/
      // "bersama" → Bank Fees, learned from the register — no hard-coded amount).
      const isChargeFee = /CHARGE\s+BERSAMA/i.test(memo);
      // Inbound BI-FAST/SKN credit: the memo names the user as BENEFICIARY, not sender, so
      // extracting "the name after KE" would wrongly produce the user's own name and make
      // this look like a me-to-me transfer. Pull the real sender instead.
      const isInboundCredit = !isChargeFee && /SKN\s+IN\s+CR|BENFC\s+BIFAST/i.test(memo);
      if (isChargeFee) {
        payee = 'Transfer Fee';
      } else if (isInboundCredit) {
        // SKN credits often carry a pipe-delimited "...|SENDER NAME|BANK NAME|..." block.
        const pipeMatch = memo.match(/\|([A-Z][A-Z\s\.']{2,40}?)\|/);
        if (pipeMatch) payee = pipeMatch[1].trim();
        else {
          const dariMatch = memo.match(/TRANSFER\s+DARI\s+([A-Z][A-Z0-9]{2,20})\b/i);
          payee = dariMatch ? `Incoming Transfer - ${dariMatch[1]}` : 'Incoming BI-FAST Transfer';
        }
      } else {
        // Heuristic: if description contains "Ke kode Bank XXX-YYY-NAME", extract NAME
        const keBankMatch = memo.match(/Ke\s+kode\s+Bank\s+\d+-\d+-([A-Z][A-Z\s\.']+?)\s+(?:DBT|CDT|CHARGE|TRF|BERSAMA|BIFAST)/);
        if (keBankMatch) payee = keBankMatch[1].trim();
        // Or "TRANSFER DARI ... KE ... NAME"
        const dariKeMatch = memo.match(/KE\s+[A-Z0-9]+\s+\d+\s+([A-Z][A-Z\s\.']+?)\s+(?:CDT|DBT)/);
        if (!payee && dariKeMatch) payee = dariKeMatch[1].trim();
      }
      // Escrow / sinking-fund credit: capture the destination account number so the
      // categorizer can look up a learned account→category mapping from the register.
      let escrowAccount = '';
      if (/TRN\s+CODE\s+FOR\s+ESCROW|ESCROW\s+(?:CREDIT|TRANSACTION)/i.test(memo)) {
        const acctMatch = memo.match(/account\s*(?:no\.?)?\s*[:.]?\s*(\d{6,})/i);
        if (acctMatch) escrowAccount = acctMatch[1];
      }
      // Fallback: FEE, admin, etc.
      if (!payee) {
        if (/FEE\s+ADMIN/i.test(memo)) payee = 'Bank Admin Fee';
        else if (/TRN\s+CODE\s+FOR\s+ESCROW/i.test(memo)) payee = 'Escrow Transfer';
        else if (/MUTASI\s+MDIN/i.test(memo)) payee = 'Mutasi MDIN';
      }

      txs.push({
        date: cur.date,
        payee,
        memo,
        amount: signedAmount,
        balance,
        escrowAccount
      });
    }

    return txs;
  }

  /* ---------------------- Bank Jago Parser ----------------------
     Bank Jago shifts its column x-positions between statement export versions, so column
     boundaries are DERIVED AT RUNTIME from the header row ("Date & Time … Balance") rather
     than hard-coded. Hard-coded windows fail silently — rows whose amount falls outside the
     window are dropped with no error, so a 48-tx statement parses as 8. The constants below
     are only a last-resort fallback for a statement whose header row can't be located.

     Key subtlety: the Date/Source/Details/Notes columns are LEFT-aligned (content starts at
     the header's left edge), but Amount and Balance are RIGHT-aligned — their values end at
     the header's RIGHT edge and can start far to its LEFT. So the numeric columns are found
     by right-edge anchoring, and the Notes/Amount boundary is derived from where the amounts
     actually begin, not from the Amount header's x position. */
  const JAGO_FALLBACK_COLS = {
    dateMax: 260, srcMin: 260, srcMax: 576, detMin: 576, detMax: 1042,
    notesMin: 1042, notesMax: 1380, amtMin: 1380, amtMax: 1600, balMin: 1600,
    amtRight: null, balRight: null
  };

  // Locate the Jago header row and derive column boundaries from it.
  function jagoColumns(items) {
    let hdr = null;
    for (const r of groupRows(items, 4)) {
      const map = {};
      for (const it of r.items) {
        const t = it.text.trim();
        // Match the header labels exactly, so "Latest Balance per 23 Aug 2026" (a summary
        // line that also contains the word "Balance") can never be mistaken for the header.
        if (/^Date\s*&\s*Time$/i.test(t)) map.date = it;
        else if (/^Source\s*\/\s*Destination$/i.test(t)) map.src = it;
        else if (/^Transaction\s+Details$/i.test(t)) map.det = it;
        else if (/^Notes$/i.test(t)) map.notes = it;
        else if (/^Amount$/i.test(t)) map.amt = it;
        else if (/^Balance$/i.test(t)) map.bal = it;
      }
      if (map.amt && map.bal && (map.date || map.notes)) { hdr = map; break; }
    }
    if (!hdr) return Object.assign({}, JAGO_FALLBACK_COLS);

    const right = (it) => it.x + (it.w || 0);
    const amtRight = right(hdr.amt);
    const balRight = right(hdr.bal);

    // Right-edge anchoring: a value belongs to Amount/Balance if its right edge lines up
    // with that header's right edge. This is stable no matter how wide the value is.
    const RTOL = 16;
    const numeric = (t) => /^[+\-]?\d[\d.]*(,\d+)?$/.test((t || '').replace(/\s+/g, ''));
    const amtVals = items.filter(it => numeric(it.text) && Math.abs(right(it) - amtRight) <= RTOL);
    const balVals = items.filter(it => numeric(it.text) && Math.abs(right(it) - balRight) <= RTOL);

    // Left bound of each numeric column = where its widest observed value starts.
    // Falls back to the midpoint between header positions when no values were found.
    const amtMin = amtVals.length
      ? Math.min.apply(null, amtVals.map(it => it.x)) - 10
      : (hdr.notes ? (hdr.notes.x + hdr.amt.x) / 2 : JAGO_FALLBACK_COLS.amtMin);
    const balMin = balVals.length
      ? Math.min.apply(null, balVals.map(it => it.x)) - 10
      : (amtRight + hdr.bal.x) / 2;

    return {
      // Left-aligned text columns end where the NEXT column's header begins.
      dateMax: hdr.src ? hdr.src.x - 8 : JAGO_FALLBACK_COLS.dateMax,
      srcMin:  hdr.src ? hdr.src.x - 8 : JAGO_FALLBACK_COLS.srcMin,
      srcMax:  hdr.det ? hdr.det.x - 8 : JAGO_FALLBACK_COLS.srcMax,
      detMin:  hdr.det ? hdr.det.x - 8 : JAGO_FALLBACK_COLS.detMin,
      detMax:  hdr.notes ? hdr.notes.x - 8 : JAGO_FALLBACK_COLS.detMax,
      notesMin: hdr.notes ? hdr.notes.x - 8 : JAGO_FALLBACK_COLS.notesMin,
      notesMax: amtMin,
      amtMin,
      amtMax: balMin,
      balMin,
      amtRight,
      balRight
    };
  }

  function parseJago(items) {
    const COLS = jagoColumns(items);
    const COL_DATE_MAX = COLS.dateMax;
    const COL_SRC_MIN = COLS.srcMin;
    const COL_SRC_MAX = COLS.srcMax;
    const COL_DETAILS_MIN = COLS.detMin;
    const COL_DETAILS_MAX = COLS.detMax;
    const COL_NOTES_MIN = COLS.notesMin;
    const COL_NOTES_MAX = COLS.notesMax;
    const COL_AMT_MIN = COLS.amtMin;
    const COL_AMT_MAX = COLS.amtMax;
    const COL_BAL_MIN = COLS.balMin;

    // Item-level filter: remove the "www.jago.com" footer tokens before row grouping.
    // Its y-position may be close enough to the last transaction's row that it would
    // otherwise contaminate the row, causing the whole row to be filtered out.
    items = items.filter(it => it.text !== 'www.jago.com');

    // Drop header/footer rows by text pattern
    const jagoBadRow = (txt) => {
      if (/Pockets\s+Transactions\s+History/i.test(txt)) return true;
      if (/^Page\s+\d+\s+of\s+\d+$/i.test(txt.trim())) return true;
      if (/Page\s+\d+\s+of\s+\d+/i.test(txt) && txt.length < 30) return true;
      if (/^Main\s+Pocket\b/i.test(txt.trim())) return true;
      // Period heading, e.g. "02 Nov 2025 - 22 Nov 2025 IDR 8.950.966"
      if (/\d{1,2}\s+\w+\s+\d{4}\s*-\s*\d{1,2}\s+\w+\s+\d{4}\s+IDR/.test(txt)) return true;
      if (/PT\s+Bank\s+Jago\s+Tbk\s+is\s+licensed/i.test(txt)) return true;
      if (/also\s+a\s+member\s+of\s+Indonesia/i.test(txt)) return true;
      if (/^Disclaimer\s*:?\s*$/i.test(txt.trim())) return true;
      if (/This\s+document\s+is\s+your\s+list\s+of\s+Jago/i.test(txt)) return true;
      if (/^Date\s*&?\s*Time\b/i.test(txt.trim()) && txt.includes('Amount')) return true;
      if (/^Source\s*\/\s*Destination\b/i.test(txt.trim())) return true;
      return false;
    };
    items = filterBadRows(items, jagoBadRow, 4);

    const rows = groupRows(items, 4);

    // Date rows: leftmost column has "DD Mmm YYYY"
    const dateRows = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const left = row.items
        .filter(it => it.x < COL_DATE_MAX)
        .map(it => it.text).join(' ').trim();
      const m = left.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\b/);
      if (!m) continue;
      const mon = monthNum(m[2]);
      if (!mon) continue;
      // Only accept rows that also have an amount-looking value in the amount column
      const hasAmount = row.items.some(it => it.x >= COL_AMT_MIN && it.x < COL_AMT_MAX && /[+\-][\d.]+/.test(it.text));
      if (!hasAmount) continue;
      const date = `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      dateRows.push({ idx: i, row, date });
    }

    if (dateRows.length === 0) return [];

    const txs = [];
    for (let i = 0; i < dateRows.length; i++) {
      const cur = dateRows[i];
      const prev = dateRows[i - 1];
      const next = dateRows[i + 1];

      const prevMid = (prev && prev.row.page === cur.row.page)
        ? (prev.row.y + cur.row.y) / 2
        : -Infinity;
      // If there's no next date row on the same page, cap the band at +100px below
      // the current date row, so we don't absorb page-footer text (disclaimers etc.)
      const nextMid = (next && next.row.page === cur.row.page)
        ? (cur.row.y + next.row.y) / 2
        : cur.row.y + 100;

      const bandItems = items.filter(it =>
        it.page === cur.row.page && it.y > prevMid && it.y <= nextMid
      );

      // Amount: date row only, amount column; may be split into "-86.000" single token
      const amountText = cur.row.items
        .filter(it => it.x >= COL_AMT_MIN && it.x < COL_AMT_MAX)
        .sort((a, b) => a.x - b.x)
        .map(it => it.text).join('');
      const amountMatch = amountText.match(/([+\-])([\d.,]+)/);
      if (!amountMatch) continue;
      const signedAmount = (amountMatch[1] === '-' ? -1 : 1) * parseID(amountMatch[2]);

      const balance = parseID(
        cur.row.items
          .filter(it => it.x >= COL_BAL_MIN)
          .sort((a, b) => a.x - b.x)
          .map(it => it.text).join('')
      );

      // Source/Destination -> Payee
      const srcItems = bandItems.filter(it => it.x >= COL_SRC_MIN && it.x < COL_SRC_MAX);
      const srcRows = groupRows(srcItems, 4);
      const srcText = srcRows.map(r => r.items.map(it => it.text).join(' ')).join(' ').replace(/\s+/g, ' ').trim();

      // Transaction Details
      const detailsItems = bandItems.filter(it => it.x >= COL_DETAILS_MIN && it.x < COL_DETAILS_MAX);
      const detailsRows = groupRows(detailsItems, 4);
      const detailsText = detailsRows.map(r => r.items.map(it => it.text).join(' ')).join(' ').replace(/\s+/g, ' ').trim();

      // Notes
      const notesItems = bandItems.filter(it => it.x >= COL_NOTES_MIN && it.x < COL_NOTES_MAX);
      const notesRows = groupRows(notesItems, 4);
      const notesText = notesRows.map(r => r.items.map(it => it.text).join(' ')).join(' ').replace(/\s+/g, ' ').trim();

      // Build payee from source column — keep first line as the clean payee
      // Source often has multi-line like "Soto ayam ceker H.rofi / DANA 9360..." — just take first row
      // Four: the payee is the Source/Destination line level with the date. Lines well above it
      // are the wrapped tail of the previous row (e.g. "62", "(Kota) ID", "CA", an account number).
      const ownSrcRows = srcRows.filter(r => r.y - cur.row.y >= -12);
      const lineText = (r) => r.items.map(it => it.text).join(' ').trim();
      const firstSrcRow = ownSrcRows[0] ? lineText(ownSrcRows[0]) : (srcRows[0] ? lineText(srcRows[0]) : '');
      let payee = firstSrcRow;
      // Digital Product Payments mask the account holder ("ADIT** PRIANS***"); the biller
      // (Biznet Home, PLN, Indosat…) is the next line.
      if (/^Digital Product Payment\b(?!\s*Fee)/i.test(detailsText) && ownSrcRows[1]) {
        const biller = lineText(ownSrcRows[1]).replace(/\s+\d{5,}\s*$/, '').trim();
        if (biller) payee = biller;
      }
      // Clean up noise patterns common in Jago
      payee = payee.replace(/\s+\d{6,}\s*$/, '').trim(); // trailing account/card numbers
      if (!payee) payee = srcText.split(/\s{2,}/)[0] || '';

      // Memo = details + notes + time (from source row 2 if any)
      const memoParts = [];
      if (detailsText) memoParts.push(detailsText);
      if (notesText) memoParts.push(notesText);
      // Include the rest of the source column (times, account numbers, IDs)
      const srcRest = srcRows.slice(1).map(r => r.items.map(it => it.text).join(' ')).join(' ').trim();
      if (srcRest) memoParts.push(srcRest);
      // Time: in date column of the row below the date (e.g., "08:53")
      const dateColBand = bandItems.filter(it => it.x < COL_DATE_MAX && it.y > cur.row.y);
      const dateColText = dateColBand.map(it => it.text).join(' ').trim();
      if (dateColText && /^\d{1,2}:\d{2}/.test(dateColText)) {
        memoParts.unshift(dateColText); // put time first
      }
      const memo = memoParts.join(' · ').replace(/\s+/g, ' ').trim();

      txs.push({
        date: cur.date,
        payee,
        memo,
        amount: signedAmount,
        balance,
        details: detailsText,
        notes: notesText
      });
    }

    return txs;
  }

  /* ---------------------- Balance-chain validation ----------------------
     The single most valuable check on a parse: every row's closing balance must equal the
     previous row's balance plus that row's amount. If a transaction is silently dropped
     (the failure mode of hard-coded column windows), the chain breaks at exactly that point.
     Without this, a partial parse looks like a complete one and quietly under-reports. */
  function validateChain(txs) {
    const usable = txs.filter(t => isFinite(t.balance));
    if (usable.length < 2) return { ok: true, checked: 0, breaks: [] };
    const breaks = [];
    for (let i = 1; i < usable.length; i++) {
      const expected = usable[i - 1].balance + usable[i].amount;
      // Statements round to 2dp; allow a rupiah of slack for float noise.
      if (Math.abs(expected - usable[i].balance) > 1) {
        breaks.push({ index: i, date: usable[i].date, expected, actual: usable[i].balance });
      }
    }
    return { ok: breaks.length === 0, checked: usable.length, breaks };
  }

  // The statement's own stated closing balance ("Latest Balance per <date>  IDR x.xxx"),
  // used to catch transactions dropped from the END of the statement — which the chain
  // check alone cannot see.
  function statedLatestBalance(items) {
    const hasLabel = items.some(it => /latest\s+balance/i.test(it.text));
    if (!hasLabel) return NaN;
    for (const it of items) {
      const m = it.text.match(/^IDR\s+([\d.,]+)$/i);
      if (m) return parseID(m[1]);
    }
    return NaN;
  }

  /* ---------------------- Categorization engine ---------------------- */
  // YNAB register is tab-delimited with quoted fields. Columns: Account, Flag, Check Number,
  // Date, Payee, Category, Master Category, Sub Category, Memo, Outflow, Inflow, Cleared, Running Balance
  function parseTSV(text) {
    // Strip BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      // Detect delimiter: tab if any tabs present, else comma
      const delim = line.includes('\t') ? '\t' : ',';
      const cells = [];
      let cur = '';
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
          else if (c === '"') { inQ = false; }
          else cur += c;
        } else {
          if (c === '"') inQ = true;
          else if (c === delim) { cells.push(cur); cur = ''; }
          else cur += c;
        }
      }
      cells.push(cur);
      rows.push(cells);
    }
    return rows;
  }

  // Build categorization model from register rows
  // Tokenize free text into a Set of clean lowercase words (≥3 letters). Strips alphanumeric
  // ID/hash blobs (anything containing a digit, e.g. transaction references like
  // "0420251103013422NSINJcuJD0ID") so they don't pollute the keyword model with noise.
  function tokenize(text) {
    const cleaned = (text || '').toLowerCase().replace(/[a-z0-9]*[0-9][a-z0-9]*/g, ' ');
    const m = cleaned.match(/[a-z]{3,}/g) || [];
    return new Set(m);
  }

  function buildModel(rows) {
    if (!rows.length) return null;
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = {
      payee: header.indexOf('payee'),
      cat: header.indexOf('category'),
      master: header.indexOf('master category'),
      memo: header.indexOf('memo'),
      outflow: header.indexOf('outflow'),
      account: header.indexOf('account'),
    };
    if (idx.payee < 0 || idx.cat < 0) {
      throw new Error('Could not find Payee/Category columns. Make sure this is the YNAB Register export.');
    }

    const payeeMap = {};       // payee -> {cat: count}
    const keywordMap = {};     // keyword -> {cat: count}
    const payeeKwMap = {};     // payee -> keyword -> {cat: count}  (for disambiguating ambiguous payees)
    const payeeAmtMap = {};    // payee -> amount -> {cat: count}  (exact-amount signal for ambiguous payees)
    const escrowAcctMap = {};  // sub-account number (from "For the Account No.X" memos) -> {cat: count}
    const accountSet = new Set(); // the user's own account names (transfer destinations)
    const allCats = new Set();
    const masterMap = {};      // category -> master
    let txCount = 0;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length <= idx.cat) continue;
      const payee = (r[idx.payee] || '').trim();
      const cat = (r[idx.cat] || '').trim();
      const memo = (idx.memo >= 0 ? (r[idx.memo] || '') : '').trim();
      // Collect account names from every row (incl. uncategorized transfers) for transfer mapping.
      if (idx.account >= 0) {
        const acc = (r[idx.account] || '').trim();
        if (acc) accountSet.add(acc);
      }
      if (!cat) continue;
      txCount++;
      allCats.add(cat);
      if (idx.master >= 0) masterMap[cat] = (r[idx.master] || '').trim();

      if (payee) {
        if (!payeeMap[payee]) payeeMap[payee] = {};
        payeeMap[payee][cat] = (payeeMap[payee][cat] || 0) + 1;
      }
      // Tokenize payee + memo for keyword model
      const seen = tokenize(payee + ' ' + memo);
      for (const t of seen) {
        if (!keywordMap[t]) keywordMap[t] = {};
        keywordMap[t][cat] = (keywordMap[t][cat] || 0) + 1;
      }
      // Per-payee per-keyword counts (for disambiguating multi-category payees like Gopay)
      if (payee) {
        if (!payeeKwMap[payee]) payeeKwMap[payee] = {};
        const pk = payeeKwMap[payee];
        for (const t of seen) {
          if (!pk[t]) pk[t] = {};
          pk[t][cat] = (pk[t][cat] || 0) + 1;
        }
      }
      // Per-payee per-amount counts. For ambiguous payees (e.g. Gopay), the rupiah amount
      // is often the only signal: 3,000 → Transportation (transit tap), 51,000/102,000 →
      // Sadaqah, 452,500 → BPJS, etc. Keyed on the integer outflow value.
      if (payee && idx.outflow >= 0) {
        const amtKey = parseMoneyKey(r[idx.outflow]);
        if (amtKey > 0) {
          if (!payeeAmtMap[payee]) payeeAmtMap[payee] = {};
          const pa = payeeAmtMap[payee];
          if (!pa[amtKey]) pa[amtKey] = {};
          pa[amtKey][cat] = (pa[amtKey][cat] || 0) + 1;
        }
      }
      // Escrow/sinking-fund sub-accounts (Dana Impian, Emergency Fund, etc.) are addressed
      // by a fixed sub-account number on the Muamalat statement ("For the Account No.X"),
      // and each number maps 1:1 to one YNAB category — learn that mapping from the register
      // instead of hard-coding account numbers (see feedback-data-driven-rules).
      const escMatch = memo.match(/account\s*(?:no\.?)?\s*[:.]?\s*(\d{6,})/i);
      if (escMatch) {
        const an = escMatch[1];
        if (!escrowAcctMap[an]) escrowAcctMap[an] = {};
        escrowAcctMap[an][cat] = (escrowAcctMap[an][cat] || 0) + 1;
      }
    }

    // Resolve top payee -> category, with confidence
    // Even ambiguous payees (low %) still get their plurality winner — better than falling
    // back to fuzzy match which can pick a completely wrong payee.
    const payees = {};
    for (const p in payeeMap) {
      const counts = payeeMap[p];
      let topC = '', topN = 0, total = 0;
      let nCats = 0;
      for (const c in counts) {
        total += counts[c];
        nCats++;
        if (counts[c] > topN) { topN = counts[c]; topC = c; }
      }
      // Accept any payee with at least 1 transaction; confidence comes from the ratio
      payees[p] = { cat: topC, n: topN, total, nCats };
    }

    // Resolve predictive keywords (≥2 hits, ≥50% predictive)
    const keywords = {};
    for (const kw in keywordMap) {
      const counts = keywordMap[kw];
      let topC = '', topN = 0, total = 0;
      for (const c in counts) {
        total += counts[c];
        if (counts[c] > topN) { topN = counts[c]; topC = c; }
      }
      if (total >= 2 && topN / total >= 0.5) {
        // weight = topN * predictiveness, used for scoring
        keywords[kw] = { cat: topC, w: topN * (topN / total) };
      }
    }

    // Resolve payee-conditional keywords — per-payee predictive keywords, only built for
    // payees that span multiple categories (e.g. Gopay → Restaurant/Tips/Transportation).
    // For each such payee, a keyword qualifies if it appears ≥2 times for that payee
    // and ≥50% of its appearances are in one category.
    const payeeKeywords = {};
    for (const p in payeeKwMap) {
      if (!payees[p] || payees[p].nCats < 2) continue;
      const kws = payeeKwMap[p];
      const out = {};
      for (const kw in kws) {
        const cs = kws[kw];
        let topC = '', topN = 0, total = 0;
        for (const c in cs) {
          total += cs[c];
          if (cs[c] > topN) { topN = cs[c]; topC = c; }
        }
        if (total >= 2 && topN / total >= 0.5) {
          out[kw] = { cat: topC, w: topN * (topN / total) };
        }
      }
      if (Object.keys(out).length) payeeKeywords[p] = out;
    }

    // Resolve payee-conditional exact-amount rules — only for ambiguous payees. An amount
    // qualifies if it appears ≥3 times for that payee and ≥70% of those land in one category.
    // This learns signals memos can't carry (e.g. Gopay 3,000 → Transportation, 51,000 →
    // Sadaqah) straight from the data, with no hard-coded magic numbers.
    const payeeAmounts = {};
    for (const p in payeeAmtMap) {
      if (!payees[p] || payees[p].nCats < 2) continue;
      const amts = payeeAmtMap[p];
      const out = {};
      for (const a in amts) {
        const cs = amts[a];
        let topC = '', topN = 0, total = 0;
        for (const c in cs) {
          total += cs[c];
          if (cs[c] > topN) { topN = cs[c]; topC = c; }
        }
        if (total >= 3 && topN / total >= 0.7) {
          out[a] = topC;
        }
      }
      if (Object.keys(out).length) payeeAmounts[p] = out;
    }

    // Resolve escrow sub-account -> category (plurality winner; a sub-account is
    // effectively dedicated to one sinking-fund category, so any single observation is
    // already a strong signal).
    const escrowAccounts = {};
    for (const an in escrowAcctMap) {
      const cs = escrowAcctMap[an];
      let topC = '', topN = 0;
      for (const c in cs) if (cs[c] > topN) { topN = cs[c]; topC = c; }
      if (topC) escrowAccounts[an] = topC;
    }

    // Build sorted category list grouped by master category
    const categories = Array.from(allCats).sort();
    // The user's own accounts, longest-first so specific names match before generic ones.
    const accounts = Array.from(accountSet).sort((a, b) => b.length - a.length);

    return {
      version: 5,
      createdAt: new Date().toISOString(),
      txCount,
      payeeCount: Object.keys(payees).length,
      payees,
      keywords,
      payeeKeywords,
      payeeAmounts,
      escrowAccounts,
      accounts,
      categories,
      masterMap,
    };
  }

  // Parse a YNAB money string ("51,000" / "1,113,426.00" / "Rp 3.000") to an integer key.
  function parseMoneyKey(s) {
    s = (s || '').toString().trim();
    if (!s) return 0;
    // Strip currency text and thousands separators, keep digits + decimal point.
    // YNAB register exports use comma as the thousands separator and dot as decimal.
    s = s.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
    const v = parseFloat(s);
    return isNaN(v) ? 0 : Math.round(Math.abs(v));
  }

  // Score memo+payee tokens against a keyword table. Returns top category or ''.
  function scoreKeywords(payee, memo, table) {
    const seen = tokenize((payee || '') + ' ' + (memo || ''));
    const scores = {};
    for (const t of seen) {
      if (table[t]) {
        const k = table[t];
        scores[k.cat] = (scores[k.cat] || 0) + k.w;
      }
    }
    let best = '', bestScore = 0;
    for (const c in scores) {
      if (scores[c] > bestScore) { bestScore = scores[c]; best = c; }
    }
    return best;
  }

  // Look up an exact-amount rule for an ambiguous payee. Returns a category or ''.
  function amountCat(knownPayee, amtKey, model) {
    if (!amtKey || !model.payeeAmounts) return '';
    const tbl = model.payeeAmounts[knownPayee];
    return (tbl && tbl[amtKey]) ? tbl[amtKey] : '';
  }

  // Lazily build a lowercase -> canonical-payee index so matching is case-insensitive.
  // ("Gopay" from a PDF resolves to "GoPay" in the register.) Stored non-enumerable so it
  // never gets serialized into localStorage.
  function lowerPayeeIndex(model) {
    if (!model._payeeLower) {
      const idx = {};
      for (const p in model.payees) {
        const lp = p.toLowerCase();
        // Prefer the shorter canonical form on collision (avoids junk like "gopay 04201...").
        if (!idx[lp] || p.length < idx[lp].length) idx[lp] = p;
      }
      Object.defineProperty(model, '_payeeLower', { value: idx, enumerable: false });
    }
    return model._payeeLower;
  }

  // Resolve the signals for a known (canonical) payee. Shared by exact + substring matching.
  function resolveKnown(key, payee, memo, amtKey, model) {
    const e = model.payees[key];
    const ratio = e.n / e.total;
    // Strong dominant payee → high confidence, return plurality winner
    if (ratio >= 0.7 && e.n >= 2) {
      return { category: e.cat, confidence: 'high' };
    }
    // Ambiguous payee. Order of signals: specific memo keyword → exact amount → plurality.
    if (model.payeeKeywords && model.payeeKeywords[key]) {
      const winner = scoreKeywords(payee, memo, model.payeeKeywords[key]);
      if (winner) return { category: winner, confidence: 'mid' };
    }
    const amtWin = amountCat(key, amtKey, model);
    if (amtWin) return { category: amtWin, confidence: 'mid' };
    return { category: e.cat, confidence: 'mid' };
  }

  // Categorize a single transaction. Returns { category, confidence }
  // `amount` is the signed transaction amount (negative for outflow); may be omitted.
  // `escrowAccount` (optional): the Muamalat sub-account number for escrow/sinking-fund
  // credits — a stronger, more specific signal than payee/memo text, so it's checked first.
  function categorize(payee, memo, amount, model, escrowAccount) {
    if (!model) return { category: '', confidence: 'none' };
    const amtKey = (amount != null && !isNaN(amount)) ? Math.round(Math.abs(amount)) : 0;

    // 0. Escrow sub-account -> category (learned from the register, see buildModel)
    if (escrowAccount && model.escrowAccounts && model.escrowAccounts[escrowAccount]) {
      return { category: model.escrowAccounts[escrowAccount], confidence: 'high' };
    }

    // 1. Exact payee match (case-insensitive)
    let key = model.payees[payee] ? payee : null;
    if (!key) {
      const canon = lowerPayeeIndex(model)[(payee || '').toLowerCase()];
      if (canon) key = canon;
    }
    if (key) return resolveKnown(key, payee, memo, amtKey, model);

    // 2. Substring payee match — only when meaningfully long.
    //    Direction A (known payee ⊆ PDF payee): prefer the LONGEST (most specific merchant).
    //    Direction B (PDF payee ⊆ longer known payee): prefer the SHORTEST (least junk, e.g.
    //    transaction-ID suffixes), so "gopay" maps to "GoPay" not "Gopay 04201...".
    const pLow = (payee || '').toLowerCase();
    if (pLow.length >= 5) {
      let bestA = null, bestALen = 0;
      let bestB = null, bestBLen = Infinity;
      for (const known in model.payees) {
        const kl = known.toLowerCase();
        if (kl.length < 5) continue;
        if (pLow.indexOf(kl) >= 0) {
          if (kl.length > bestALen) { bestALen = kl.length; bestA = known; }
        } else if (kl.indexOf(pLow) >= 0) {
          if (kl.length < bestBLen) { bestBLen = kl.length; bestB = known; }
        }
      }
      const bestKnown = bestA || bestB;
      if (bestKnown) return resolveKnown(bestKnown, payee, memo, amtKey, model);
    }

    // 3. Global keyword scoring on payee + memo (fallback for unknown payees)
    const winner = scoreKeywords(payee, memo, model.keywords);
    if (winner) return { category: winner, confidence: 'mid' };
    return { category: '', confidence: 'none' };
  }

  /* ---------------------- Internal transfer detection ----------------------
     YNAB leaves internal (account-to-account) transfers uncategorized. We detect them from
     the bank statement and suggest a "Transfer : <account>" payee with a BLANK category.
     Signals, in priority order:
       1. Cash withdrawal (ATM)            → Transfer : Cash
       2. "Movement between Pockets"       → Transfer : <pocket / card>  (Jago)
       3. Counterparty is the user himself → Transfer : <other own account>  (e.g. Muamalat↔Jago)
     External sends to other people (different name + foreign bank) are NOT flagged.
     Escrow / sinking-fund moves are left alone — ambiguous in the user's own data. */

  // Find the user's known account whose name best matches the given text (used for pocket
  // moves, where the payee is the pocket/card name e.g. "Corporate Card"). Accounts are
  // pre-sorted longest-first, so the most specific full-name match wins.
  function matchAccount(text, accounts) {
    if (!accounts) return '';
    const low = (text || '').toLowerCase();
    for (const acc of accounts) {
      if (low.indexOf(acc.toLowerCase()) >= 0) return acc;   // full account name in the text
    }
    // Looser: the account's distinctive leading word(s) (e.g. "Cash", "Corporate Card")
    for (const acc of accounts) {
      const head = acc.toLowerCase().split(/[-:]/)[0].trim();
      if (head.length >= 4 && low.indexOf(head) >= 0) return acc;
    }
    return '';
  }

  // Find the user's primary account for a given bank keyword ("muamalat" / "jago").
  // Prefers the account whose name contains "main"; otherwise the shortest (most generic) one.
  function findBankAccount(keyword, accounts) {
    const cands = (accounts || []).filter(a => a.toLowerCase().indexOf(keyword) >= 0);
    if (!cands.length) return '';
    const main = cands.find(a => /main/i.test(a));
    return main || cands.slice().sort((a, b) => a.length - b.length)[0];
  }

  // Returns { isTransfer:true, payee:'Transfer : X' } or null.
  // `bank` is 'jago' | 'muamalat'; `ownNames` is an array of lowercased own-name strings.
  function detectTransfer(payee, memo, amount, bank, model, ownNames) {
    const p = (payee || '').toLowerCase();
    const m = (memo || '').toLowerCase();
    const text = p + ' ' + m;
    const accounts = (model && model.accounts) || [];
    const mkPayee = (acc) => 'Transfer : ' + acc;

    // 0. Inbound BI-FAST/SKN credits are external income (salary, client payment, gift —
    //    the "own name" that matches in rule 3 below is just the BENEFICIARY field the bank
    //    always fills in, not evidence the sender is also the user). Never treat as internal.
    if (text.indexOf('skn in cr') >= 0 || text.indexOf('benfc bifast') >= 0) return null;

    // 1. Cash withdrawal → Transfer : Cash (exclude the separate withdrawal FEE line)
    if ((text.indexOf('cash withdrawal') >= 0 || text.indexOf('cwatm') >= 0) && text.indexOf('fee') < 0) {
      const acc = matchAccount('cash', accounts);
      return { isTransfer: true, payee: acc ? mkPayee(acc) : 'Transfer : Cash' };
    }

    // 2. Jago pocket movement → Transfer : <pocket/card>
    if (m.indexOf('movement between pockets') >= 0 || m.indexOf('pocket money') >= 0) {
      const acc = matchAccount(payee, accounts) || matchAccount(memo, accounts);
      return { isTransfer: true, payee: acc ? mkPayee(acc) : 'Transfer' };
    }

    // 3. Me-to-me transfer: counterparty is the user. These are "big nominal" moves, so a
    //    minimum amount guards against tiny same-name bank-fee lines (which ARE categorized).
    const ownMatch = ownNames && ownNames.length &&
      ownNames.some(n => n && p.indexOf(n) >= 0);
    if (ownMatch && Math.abs(amount || 0) >= 100000) {
      // Best-effort destination = the primary account of the "other" bank.
      let acc = '';
      if (m.indexOf('muamalat') >= 0) acc = findBankAccount('muamalat', accounts);
      else if (m.indexOf('jago') >= 0) acc = findBankAccount('jago', accounts);
      else if (bank === 'muamalat') acc = findBankAccount('jago', accounts);   // money to/from Jago
      else if (bank === 'jago') acc = findBankAccount('muamalat', accounts);   // money to/from Muamalat
      return { isTransfer: true, payee: acc ? mkPayee(acc) : 'Transfer' };
    }

    return null;
  }
  function detectBank(items) {
    const sample = items.slice(0, 400).map(it => it.text).join(' ').toLowerCase();
    if (sample.indexOf('pt bank jago') >= 0 || sample.indexOf('www.jago.com') >= 0 ||
        sample.indexOf('pockets transactions') >= 0) return 'jago';
    if (sample.indexOf('laporan e-statement') >= 0 || sample.indexOf('rincian transaksi') >= 0 ||
        sample.indexOf('muamalat') >= 0) return 'muamalat';
    if (sample.indexOf('jago') >= 0) return 'jago';
    return null;
  }

  // Build IndoYNAB's model straight from the YNAB 4 budget. Categories are keyed by YNAB
  // category id, so suggestions map back to the budget without any name matching.
  function modelFromBudget(b) {
    var rows = [['Account', 'Payee', 'Category', 'Master Category', 'Memo', 'Outflow']];
    b.transactions.forEach(function (t) {
      var acc = b.accountById[t.accountId]; if (!acc) return;
      var p = b.payeeById[t.payeeId];
      var payee = t.importedPayee && !/^Payee\/Transfer/.test(t.payeeId || '') ? (p ? p.name : t.importedPayee) : (p ? p.name : '');
      var parts = t.categoryId === 'Category/__Split__' ? (b.subsByParent[t.entityId] || []) : [t];
      parts.forEach(function (s) {
        var cid = s.categoryId || '';
        if (cid && !b.categoryById[cid] && !/^Category\/__(Immediate|Deferred)Income__$/.test(cid)) cid = '';
        var memo = [t.memo, s !== t ? s.memo : ''].filter(Boolean).join(' ');
        rows.push([acc.accountName, payee, cid, '', memo, s.amount < 0 ? String(Math.round(-s.amount)) : '0']);
      });
      // bank text often differs from the cleaned payee: learn it as its own payee too
      if (t.importedPayee && p && t.importedPayee.toLowerCase() !== (p.name || '').toLowerCase() && t.categoryId && t.categoryId !== 'Category/__Split__')
        rows.push([acc.accountName, t.importedPayee, t.categoryId, '', t.memo || '', t.amount < 0 ? String(Math.round(-t.amount)) : '0']);
    });
    b.accountBalances().forEach(function (a) { rows.push([a.name, '', '', '', '', '0']); });
    return buildModel(rows);
  }

  // A note the user typed that names one of their categories ("uang masak", "work related")
  // is the strongest signal there is. Whole-word, case-insensitive, longest name wins.
  function categoryFromNote(note, b) {
    if (!note) return null;
    var low = ' ' + note.toLowerCase().replace(/[^a-z0-9&]+/g, ' ') + ' ', best = null;
    Object.keys(b.categoryById).forEach(function (id) {
      var c = b.categoryById[id]; if (c.isTombstone) return;
      var mc = (b.masterCategories.find(function (m) { return m.entityId === c.masterCategoryId; }) || {});
      if (mc.entityId === 'MasterCategory/__Hidden__') return;
      var name = c.name.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
      if (name.length < 4) return;
      if (low.indexOf(' ' + name + ' ') >= 0 && (!best || name.length > best.len)) best = { id: id, len: name.length };
    });
    return best && best.id;
  }

  // Which account the statement belongs to, from its header.
  //  Jago:     "Bekasi Card 503972700320" / "Main Pocket 501049924055" under the holder's name
  //  Muamalat: the 10-digit number after "No Rekening"
  function statementIdentity(items, bank) {
    var head = items.slice(0, 60);
    if (bank === 'jago') {
      for (var i = 0; i < head.length; i++) {
        var m = /^(.*?[A-Za-z].*?)\s+(\d{10,16})$/.exec(head[i].text);
        if (m && !/^IDR\b/i.test(m[1])) return { pocket: m[1].trim(), accountNo: m[2] };
      }
    } else if (bank === 'muamalat') {
      var at = head.findIndex(function (it) { return /no\.?\s*rekening/i.test(it.text); });
      for (var j = Math.max(0, at); j < head.length; j++) if (/^\d{10}$/.test(head[j].text)) return { pocket: null, accountNo: head[j].text };
    }
    return { pocket: null, accountNo: null };
  }

  async function readStatement(arrayBuffer) {
    var items = await extractItems(arrayBuffer);
    var bank = detectBank(items);
    if (!bank) throw new Error('This PDF does not look like a Bank Jago or Bank Muamalat statement.');
    var txs = bank === 'muamalat' ? parseMuamalat(items) : parseJago(items);
    var id = statementIdentity(items, bank);
    return { bank: bank, txs: txs, chain: validateChain(txs), stated: statedLatestBalance(items), pocket: id.pocket, accountNo: id.accountNo };
  }

  root.Statements = {
    readStatement: readStatement, modelFromBudget: modelFromBudget, categoryFromNote: categoryFromNote, categorize: categorize, detectTransfer: detectTransfer,
    detectBank: detectBank, extractItems: extractItems, parseJago: parseJago, parseMuamalat: parseMuamalat, validateChain: validateChain, buildModel: buildModel
  };
})(typeof window !== 'undefined' ? window : globalThis);
