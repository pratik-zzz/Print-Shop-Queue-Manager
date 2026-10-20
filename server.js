const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database(path.join(__dirname, 'print_queue.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_number INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    color_mode TEXT CHECK(color_mode IN ('bw', 'color')) NOT NULL,
    is_duplex INTEGER DEFAULT 0,
    copies INTEGER DEFAULT 1,
    page_range TEXT DEFAULT NULL,
    status TEXT CHECK(status IN ('pending', 'completed')) DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Settings table for queue pause state
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('queue_paused', '0');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('upi_id', '');

// Migrate: add page_range column to existing databases
const printCols = db.prepare('PRAGMA table_info(print_jobs)').all().map((c) => c.name);
if (!printCols.includes('page_range')) {
  db.prepare('ALTER TABLE print_jobs ADD COLUMN page_range TEXT DEFAULT NULL').run();
}

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const sanitizeFileName = (name) => {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
};

const todayUtcDate = () => new Date().toISOString().slice(0, 10);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    cb(null, `temp-${Date.now()}-${sanitizeFileName(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ext === '.pdf');
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
  next();
});
// POST /api/jobs — create a print job
app.post('/api/jobs', upload.single('file'), (req, res) => {
  const cleanup = () => {
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch (_) { /* ignore */ }
    }
  };

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { name, color_mode, is_duplex, copies, page_range } = req.body;

    // Block uploads when queue is paused
    const pausedRow = db.prepare("SELECT value FROM settings WHERE key = 'queue_paused'").get();
    if (pausedRow && pausedRow.value === '1') {
      cleanup();
      return res.status(400).json({ success: false, error: 'Queue temporarily paused. Please wait.' });
    }

    if (!name || !name.trim()) {
      cleanup();
      return res.status(400).json({ success: false, error: 'Customer name is required' });
    }

    // Daily sequential token: reset when the UTC date changes
    const today = todayUtcDate();
    const row = db.prepare(
      'SELECT MAX(token_number) AS max FROM print_jobs WHERE date(created_at) = ?'
    ).get(today);
    const token = (row.max || 0) + 1;

    // Final stored filename: [token]-[timestamp]-[sanitized-original].pdf
    const timestamp = Date.now();
    const safeName = sanitizeFileName(req.file.originalname);
    const storedName = `${token}-${timestamp}-${safeName}`;
    const finalPath = path.join(uploadsDir, storedName);
    fs.renameSync(req.file.path, finalPath);

    const colorMode = color_mode === 'color' ? 'color' : 'bw';
    const isDuplex = is_duplex === '1' || is_duplex === 1 || is_duplex === true || is_duplex === 'true' ? 1 : 0;
    const copiesNum = Math.max(1, parseInt(copies, 10) || 1);
    const pageRange = page_range && String(page_range).trim() ? String(page_range).trim() : null;

    const info = db.prepare(
      `INSERT INTO print_jobs
         (token_number, customer_name, file_name, file_path, color_mode, is_duplex, copies, page_range, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(token, name.trim(), safeName, finalPath, colorMode, isDuplex, copiesNum, pageRange);

    return res.json({ success: true, token, jobId: info.lastInsertRowid });
  } catch (err) {
    cleanup();
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/jobs/active — pending jobs for today
app.get('/api/jobs/active', (_req, res) => {
  const today = todayUtcDate();
  const rows = db.prepare(
    `SELECT * FROM print_jobs
     WHERE status = 'pending' AND date(created_at) = ?
     ORDER BY created_at ASC`
  ).all(today).map((job) => ({ ...job, stored_file: path.basename(job.file_path) }));
  res.json(rows);
});

// GET /api/jobs/completed — completed jobs for today
app.get('/api/jobs/completed', (_req, res) => {
  const today = todayUtcDate();
  const rows = db.prepare(
    `SELECT * FROM print_jobs
     WHERE status = 'completed' AND date(created_at) = ?
     ORDER BY created_at ASC`
  ).all(today).map((job) => ({ ...job, stored_file: path.basename(job.file_path) }));
  res.json(rows);
});

// GET /api/jobs/status/:id — lightweight status check for customer screens
app.get('/api/jobs/status/:id', (req, res) => {
  const row = db.prepare(
    'SELECT id, token_number, status, customer_name FROM print_jobs WHERE id = ?'
  ).get(req.params.id);
  if (!row) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }
  res.json({ success: true, job: row });
});

// PATCH /api/jobs/:id/complete — mark a job as completed
app.patch('/api/jobs/:id/complete', (req, res) => {
  const result = db.prepare(
    "UPDATE print_jobs SET status = 'completed' WHERE id = ? AND status = 'pending'"
  ).run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ success: false, error: 'Job not found or already completed' });
  }
  res.json({ success: true });
});

// GET /api/settings/pause — get queue pause state
app.get('/api/settings/pause', (_req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'queue_paused'").get();
  res.json({ paused: row && row.value === '1' });
});

// PATCH /api/settings/pause — toggle queue pause state
app.patch('/api/settings/pause', (_req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'queue_paused'").get();
  const current = row && row.value === '1';
  const next = current ? '0' : '1';
  db.prepare("UPDATE settings SET value = ? WHERE key = 'queue_paused'").run(next);
  res.json({ paused: next === '1' });
});

// GET /api/settings/upi — get current UPI ID
app.get('/api/settings/upi', (_req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'upi_id'").get();
  res.json({ upi_id: row ? row.value : 'shopupi@upi' });
});

// PATCH /api/settings/upi — set/update UPI ID
app.patch('/api/settings/upi', (req, res) => {
  const { upi_id } = req.body;
  if (upi_id === undefined) {
    return res.status(400).json({ success: false, error: 'UPI ID is required' });
  }
  const trimmed = String(upi_id).trim();
  db.prepare("INSERT INTO settings (key, value) VALUES ('upi_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(trimmed);
  res.json({ success: true, upi_id: trimmed });
});

// Auto-delete uploaded PDFs and DB records older than 3 hours
const FILE_MAX_AGE = 3 * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 60 * 1000;

const cleanupOldFiles = () => {
  const cutoff = new Date(Date.now() - FILE_MAX_AGE).toISOString();
  const oldJobs = db.prepare(
    'SELECT id, file_path FROM print_jobs WHERE created_at < ?'
  ).all(cutoff);
  for (const job of oldJobs) {
    try { fs.unlinkSync(job.file_path); } catch (_) { /* ignore */ }
    db.prepare('DELETE FROM print_jobs WHERE id = ?').run(job.id);
  }
};

cleanupOldFiles();
setInterval(cleanupOldFiles, CLEANUP_INTERVAL);

// GET /uploads/:filename — serve stored PDF inline
app.get('/uploads/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ success: false, error: 'Invalid filename' });
  }
  const filePath = path.join(uploadsDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }
  res.sendFile(filePath, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`
    }
  });
});

app.listen(PORT, () => {
  console.log(`Print Queue Manager running at http://localhost:${PORT}`);
});

