const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const puppeteer = require("puppeteer");

// Charge .env simple (sans dépendance)
function loadDotEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {
    // ignore dotenv load errors
  }
}

loadDotEnv(path.join(__dirname, ".env"));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowTs() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(__dirname, p);
}

const IN_DIR = resolveFromRoot(process.env.IN_DIR || "in");
const OUT_DIR = resolveFromRoot(process.env.OUT_DIR || "out");
const LOG_DIR = resolveFromRoot(process.env.LOG_DIR || "log");
ensureDir(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, `log-${nowTs()}.txt`);

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {
    // ignore logging failures
  }
  console.error(line.trim());
}

function parseArgNum(name, defVal) {
  const re = new RegExp(`^--${name}=(.*)$`);
  for (const a of process.argv.slice(2)) {
    const m = a.match(re);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return defVal;
}

function parseArgBool(name, defVal) {
  const re = new RegExp(`^--${name}=(.*)$`);
  for (const a of process.argv.slice(2)) {
    const m = a.match(re);
    if (m) {
      const v = m[1].toLowerCase();
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
    }
  }
  return defVal;
}

const ENV_MAX = process.env.MAX_ITEMS
  ? Number(process.env.MAX_ITEMS)
  : undefined;
const ENV_CONC = process.env.CONCURRENCY
  ? Number(process.env.CONCURRENCY)
  : undefined;
const ENV_HEADLESS = process.env.HEADLESS;

const MAX_ITEMS = parseArgNum("max", ENV_MAX ?? 30); // limite test demandée
const CONCURRENCY = parseArgNum("concurrency", ENV_CONC ?? 5);
const HEADLESS = parseArgBool(
  "headless",
  ENV_HEADLESS !== undefined
    ? ["1", "true", "yes", "on"].includes(String(ENV_HEADLESS).toLowerCase())
    : true
);

function sheetToRowsArray(sheet) {
  // Retourne un tableau de lignes (array) avec header:1 pour garder les colonnes fixes
  return xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
}

function writeResultsToExcel(rows, outfile) {
  // rows: array of [reference, availability]
  const wb = xlsx.utils.book_new();
  const header = [["Reference", "Available"]];
  const ws = xlsx.utils.aoa_to_sheet(header.concat(rows));
  xlsx.utils.book_append_sheet(wb, ws, "Disponibilites");
  ensureDir(path.dirname(outfile));
  xlsx.writeFile(wb, outfile);
}

async function withPage(browser, fn) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);
    return await fn(page);
  } finally {
    try {
      await page.close();
    } catch (_) {}
  }
}

async function checkAvailabilityFile1(browser, url) {
  return withPage(browser, async (page) => {
    let status = null;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      status = resp ? resp.status() : null;
    } catch (e) {
      logLine(`Navigation error (file1) for ${url}: ${e.message}`);
      return 0;
    }
    if (status === 404) return 0;

    try {
      const result = await page.evaluate(() => {
        const img = document.querySelector("#p-availability img");
        if (!img) return 0;
        const val = (
          img.getAttribute("alt") ||
          img.getAttribute("title") ||
          img.getAttribute("aria-label") ||
          img.alt ||
          ""
        )
          .trim()
          .toLowerCase();
        if (val === "disponibilità si") return 1;
        const containerText = (
          img.closest("#p-availability")?.textContent || ""
        )
          .trim()
          .toLowerCase();
        return containerText === "disponibilità si" ||
          containerText.includes("disponibilità si")
          ? 1
          : 0;
      });
      return result ? 1 : 0;
    } catch (e) {
      logLine(`DOM eval error (file1) for ${url}: ${e.message}`);
      return 0;
    }
  });
}

async function checkAvailabilityFile2(browser, url) {
  return withPage(browser, async (page) => {
    let status = null;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
      status = resp ? resp.status() : null;
    } catch (e) {
      logLine(`Navigation error (file2) for ${url}: ${e.message}`);
      return 0;
    }
    if (status === 404) return 0;

    try {
      const result = await page.evaluate(() => {
        const el = document.querySelector("#product-availability");
        if (!el) return 0;
        const t = (el.textContent || "").trim().toUpperCase();
        return t.includes("EN STOCK") ? 1 : 0;
      });
      return result ? 1 : 0;
    } catch (e) {
      logLine(`DOM eval error (file2) for ${url}: ${e.message}`);
      return 0;
    }
  });
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  let active = 0;
  return await new Promise((resolve) => {
    const launchNext = () => {
      while (active < concurrency && next < items.length) {
        const idx = next++;
        active++;
        Promise.resolve()
          .then(() => worker(items[idx], idx))
          .then((res) => {
            results[idx] = res;
          })
          .catch((err) => {
            results[idx] = err;
          })
          .finally(() => {
            active--;
            if (next >= items.length && active === 0) resolve(results);
            else launchNext();
          });
      }
    };
    launchNext();
  });
}

function loadFirstExisting(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function processFile1(browser) {
  const infile = loadFirstExisting([
    path.join(IN_DIR, "fichier1.xlsx"),
    path.join(IN_DIR, "fichiers1.xlsx"), // tolère typo
  ]);
  if (!infile) {
    logLine("Input manquant: in/fichier1.xlsx");
    return;
  }
  const wb = xlsx.readFile(infile);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = sheetToRowsArray(ws);

  // Construire liste {ref,url}
  const items = [];
  for (const r of rows) {
    const id = r[0];
    const url = r[1];
    if (!url || typeof url !== "string") continue;
    const ref = `REF-${id}`;
    items.push({ ref, url });
    if (items.length >= MAX_ITEMS) break;
  }
  if (items.length === 0) {
    logLine("Aucun élément valide trouvé dans fichier1.xlsx");
    return;
  }

  const results = await runPool(
    items,
    async (it) => {
      try {
        const avail = await checkAvailabilityFile1(browser, it.url);
        return [it.ref, avail];
      } catch (e) {
        logLine(`Erreur item (file1) ${it.ref}: ${e.message}`);
        return [it.ref, 0];
      }
    },
    CONCURRENCY
  );

  const outfile = path.join(OUT_DIR, "fichier1.availability.xlsx");
  writeResultsToExcel(results, outfile);
  console.log(`Ecrit: ${outfile}`);
}

async function processFile2(browser) {
  const infile = loadFirstExisting([
    path.join(IN_DIR, "fichier2.xlsx"),
    path.join(IN_DIR, "fichiers2.xlsx"), // tolère typo
  ]);
  if (!infile) {
    logLine("Input manquant: in/fichier2.xlsx");
    return;
  }
  const wb = xlsx.readFile(infile);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = sheetToRowsArray(ws);

  const items = [];
  for (const r of rows) {
    const ref = r[0];
    const url = r[1];
    if (!ref || !url || typeof url !== "string") continue;
    items.push({ ref: String(ref), url });
    if (items.length >= MAX_ITEMS) break;
  }
  if (items.length === 0) {
    logLine("Aucun élément valide trouvé dans fichier2.xlsx");
    return;
  }

  const results = await runPool(
    items,
    async (it) => {
      try {
        const avail = await checkAvailabilityFile2(browser, it.url);
        return [it.ref, avail];
      } catch (e) {
        logLine(`Erreur item (file2) ${it.ref}: ${e.message}`);
        return [it.ref, 0];
      }
    },
    CONCURRENCY
  );

  const outfile = path.join(OUT_DIR, "fichier2.availability.xlsx");
  writeResultsToExcel(results, outfile);
  console.log(`Ecrit: ${outfile}`);
}

async function main() {
  ensureDir(OUT_DIR);
  ensureDir(IN_DIR);
  ensureDir(LOG_DIR);

  console.log("Démarrage scraping...");
  console.log(
    `Limite: ${MAX_ITEMS}, Concurrency: ${CONCURRENCY}, Headless: ${HEADLESS}`
  );

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    await processFile1(browser);
    await processFile2(browser);
  } finally {
    try {
      await browser.close();
    } catch (_) {}
  }
}

main().catch((e) => {
  logLine(`Fatal: ${e.message}`);
  process.exitCode = 1;
});
